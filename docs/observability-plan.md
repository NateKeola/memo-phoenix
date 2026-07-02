# Observability plan: operator and developer legibility (2026-07-01)

Design only (recommendations, phased by leverage). Grounded in the incidents the 2026-07-01 audit
verified (see `docs/system-audit.md`); every proposal below traces to a real failure that was
invisible or diagnosable only by hand-querying the database.

## What exists today (verified)

- `telemetry_events`: a genuinely rich WRITE-side stream (17 live event types for the real user:
  per-stage miner events with usage, `mine:complete` token totals, `chat_query` with tool/iteration
  detail, capture/interview/correction/companion events). Fire-and-forget service-role inserts
  (`lib/telemetry.ts`). There is NO read surface anywhere; the operator must run SQL.
- `miner_runs`: the lock + audit row, written at START and END only. `summary` jsonb is rich
  (per-pass rows/inserted/updated/unchanged/batches/usage/discrepancyItems). No mid-run writes.
- `/api/miner/status` returns the latest run row raw; `/api/miner/state` returns the auto-run
  measure; `/miner` renders a ledger + progress bar; `/building` polls status.
- Stale-run reclaim exists only inside `mineWithLock`, i.e. it runs at the start of the NEXT
  attempt (`run.ts:113-131`).
- Console logs on Vercel/the Action are the only per-pass trace; ephemeral.
- Security guards (`check-rls.mjs` etc.) run manually and are green.

## The incidents that define the requirements

1. Zombie runs: killed serverless mines left `running` rows for 1-9 hours; /building showed
   "building your memory" the whole time; nothing distinguished dead from slow.
2. A zombie run also silently disabled background mining: `shouldAutoRun` treats any `running` row
   as active with no age check, and the cron sweep skips on it.
3. The daily cron sweep has NEVER dispatched a mine, and nothing can tell whether that is because
   its secrets are unset or because the threshold was never crossed: a cron invocation that does
   nothing leaves no trace.
4. Mid-pass death (the 06-30 JSON truncation) was diagnosable only because it happened on a CLI
   run with a console; the same death on Vercel would have surfaced as nothing but a zombie.
5. Config drift was invisible: custom SMTP unset (open PR #32 assumed it configured), redirect
   allowlist empty, `MINER_USE_GITHUB_ACTION` inactive so "Run now" ran inline and died. All found
   only via Management-API reads during the audit.
6. Data-quality drift was invisible: near-duplicate people minted by the 07-01 fold, a
   double-ingested 59k capture, 16 accumulated recurring_tension insights. No surface shows any of
   this; the graph "looked fine" until queried by hand.
7. The one invited beta user has been stuck since 06-21 (account created, never onboarded, zero
   captures); no funnel signal distinguishes stuck from inactive.
8. Telemetry cannot be correlated to a run: no run_id on events; the per-pass stage events do not
   even fire on the incremental path.

## Design principles

- Two audiences, one substrate: the operator reads surfaces; the developer reads rows. Both come
  from the same run row + pipeline-event stream. No external APM/OTel/Grafana at a 5-user scale.
- Reuse existing seams: `PassResult` already carries everything a per-stage trace needs;
  `mineWithLock` already brackets the run; `miner_runs` is mutable by design. Additions are
  inserts/updates at existing boundaries, not new plumbing.
- Every silent state gets a visible terminal: running -> done | error | STALLED. Every scheduled
  job leaves a heartbeat even when it does nothing.
- Deterministic self-checks over dashboards: a config panel and a daily digest beat charts here.

## Phase 1: operator legibility (highest leverage; part is being built in the fix pass)

1. Heartbeat + stage on `miner_runs` (columns `heartbeat_at`, `stage`; mutable table, one small
   migration). The miner updates both at each pass boundary (~10 UPDATEs per run). Status reads
   compute an EFFECTIVE status: `running` with a heartbeat older than a few minutes = `stalled`,
   surfaced in /building and /miner as a plain failure with a retry affordance, and ignored by the
   auto-run measure so a zombie cannot suppress mining. Reclaim keys on heartbeat age instead of
   started_at age (also fixes the live-run-reclaimed-at-20-min hazard). This kills incident
   classes 1, 2, and most of 4.
2. Last-run panel on /miner: outcome, MODE (full / incremental / noop), duration, error text
   verbatim, per-pass table from `summary`. Render "stale run reclaimed" as what it is ("this run
   was killed, likely a timeout on <runtime>") with the remedy.
3. Pending-work counters on /miner: unincorporated captures (exists), PENDING CORRECTIONS (new:
   corrections filed after the last successful mine; today they are invisible and do not trigger
   anything), and a "how the next mine will run" line (mode + runtime + threshold state).
4. Config self-check on /admin (operator-only): presence of CRON_SECRET, GITHUB_DISPATCH_TOKEN,
   GITHUB_REPO, MINER_USE_GITHUB_ACTION, NEXT_PUBLIC_SITE_URL, MEMO_ADMIN_EMAIL; a documented
   manual checklist for what in-app creds cannot read (SMTP configured, redirect allowlist).
   Kills incident class 5.

## Phase 2: developer trace

5. `pipeline_events` table (run_id, user_id, stage, table_name, phase start|end|error, claims_in,
   rows_out, inserted/updated/unchanged, batches, tokens in/out/cache, duration_ms, error text,
   created_at). Service-role write, per-user SELECT, mutable-table pattern (like miner_state).
   Written from mineWithLock (run start/end), the extract loop (aggregate + per-capture on error),
   and each pass (straight from PassResult). One query traces a run end to end; a run that died
   shows exactly which stage and batch it died in. Kills the rest of incident 4.
6. Stamp run_id into all miner telemetry attrs (mineWithLock already has it; thread it through
   mine()). Add the per-pass stage events to the incremental path for parity with the full path,
   and keep the freshness counters on a consistent event regardless of path (incident 8).
7. Sweep heartbeat: `/api/cron/miner-sweep` writes one event per invocation with
   {users_checked, dispatched, skipped_below_threshold, skipped_active, dispatch_errors}, even
   when it does nothing; `lib/miner/dispatch.ts` logs dispatch failures. "Cron dead" becomes
   distinguishable from "below threshold" (incident 3).

## Phase 3: data-quality signals

8. Post-run graph audit (deterministic, no LLM, runs after freshness inside the miner): counts of
   near-duplicate label clusters (pairwise token overlap on current people/places), per-type
   insight accumulation, orphan claim references, dangling superseded_by pointers, rows citing
   claims from excluded captures. Emitted as one `graph_audit` telemetry event and rendered as a
   one-line "graph health" chip on /miner. Incident 6 becomes a number that moves, and the
   duplication class of bug becomes visible the day it regresses.
9. Ingest anomaly events: identical-body-hash capture rejected (dedup guard, being built in the
   fix pass), oversized capture rejected, STT failure, interview transcript-fetch failure. Each of
   these currently either cannot happen loudly or vanishes into a console.
10. Funnel events: account_created, login_succeeded, recovery_link_generated/used,
    onboarding_started/completed/skipped, first_capture, first_mine_done. A stuck user (incident
    7) becomes a query: started minus completed.

## Phase 4: digest and alerting

11. Daily digest: extend the existing daily cron to compose, per user: runs + outcomes + stalled
    count, pending captures/corrections, graph-audit deltas, config-check failures. Render on
    /admin now; email it once SMTP exists. GitHub Action failures already email the operator
    natively; document that as the alerting channel for Action-run mines.
12. Optional later: Vercel log drain for structured console JSON. Explicit non-goals: OpenTelemetry,
    external APM, client-side RUM, token-level streaming metrics.

## Appendix: queries the operator can run today (Management API, read-only, user-scoped)

Latest run + effective state:
  select status, trigger, runtime, started_at, ended_at, error from miner_runs
  where user_id='<uid>' order by started_at desc limit 5;
Zombie detector (pre-heartbeat):
  select id, started_at from miner_runs where user_id='<uid>' and status='running'
  and started_at < now() - interval '30 minutes';
Pending work:
  select count(*) from captures c where c.user_id='<uid>' and not exists
  (select 1 from miner_state m where m.user_id=c.user_id and m.scope='incorporated:'||c.id);
  select count(*) from corrections where user_id='<uid>' and created_at >
  (select coalesce(max(started_at),'epoch') from miner_runs where user_id='<uid>' and status='done');
Near-duplicate people (first-token cluster heuristic):
  select split_part(lower(label),' ',1) tok, count(*), array_agg(label) from canonical_people
  where user_id='<uid>' and valid_to is null group by 1 having count(*)>1;
Telemetry by day:
  select created_at::date, event_type, count(*) from telemetry_events where user_id='<uid>'
  group by 1,2 order by 1 desc, 3 desc;
