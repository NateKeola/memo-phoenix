# PR verification: recent claims vs reality (2026-07-01)

Read-only audit of the claims made by recent PRs and decision-log entries, verified against the
current code (origin/main, tip bcf9c56 = PR #31 merge; PR #32 open), the live Supabase schema and
config (project azlobwtiptvarfeukzcv, via the Management API), and per-user-scoped data queries
(real user `691c75b5`; the 8 `inc-harness-*` users are documented test residue and were excluded
from every aggregate). Every verdict below was produced by one auditor and then adversarially
re-verified by an independent checker; where the checker corrected the auditor, the corrected
verdict is shown. Method notes and the full findings live in `docs/system-audit.md`.

Verdict key: CONFIRMED (holds as claimed), PARTIAL (holds with a real qualifier), NOT TRUE
(does not hold against reality).

## Auth and security (B1/B2, PR #24)

| Claim | Verdict | Evidence |
|---|---|---|
| Auth is email+password+allowlist, guard on every protected route | CONFIRMED | `app/login/actions.ts:15-80`; `lib/auth/guard.ts:44-52` (getUser + isAllowed per request); coverage grep: all 9 user API routes and every protected page/action call the guard. Deliberate exceptions are sound (admin uses the stronger operator gate; cron uses CRON_SECRET; the two client capture pages rely on their guarded APIs, documented). |
| Public signups disabled; no signup surface; createAccount cannot mint non-invited | CONFIRMED | Live `disable_signup=true`; zero client `signUp`/`signInWithOtp` calls in the tree; only account mint is service-role `admin.createUser` behind `isInvited` (`app/login/actions.ts:47-53`). |
| RLS forced on every table, policies `user_id = auth.uid()` | PARTIAL | All 31 tables rls+forced; all 51 policies are exactly `(user_id = auth.uid())` on `{authenticated}`; canonical bucket and telemetry SELECT-only for clients. Qualifier (medium-low defect): `invites` has INSERT/UPDATE/DELETE policies for any authenticated user, and `isInvited()` matches by email only, so an already-invited user with the anon key could append an invites row and allowlist an arbitrary email. Defense-in-depth gap, not a data leak. |
| Operator gating via MEMO_ADMIN_EMAIL / MEMO_USER_ID | PARTIAL | Code as documented (`lib/auth/operator.ts:11-18`). Locally only `MEMO_USER_ID` is set; `MEMO_ADMIN_EMAIL` is not, so email-dependent branches (forgot-password admin display, the operator's own self-service reset allowlist check) silently degrade if the deployed env mirrors local. |
| Onboarding gate: invited-and-not-onboarded forced to /onboarding | PARTIAL | Gate works for pages (`lib/supabase/middleware.ts:59-67`). Qualifier: `/api/*` is exempt, so a not-onboarded user can drive every API directly (the allowlist guard still applies); and the gate has no escape hatch, which is load-bearing for the Todd dead-end below. |

## Incremental mining (PR #27, #28, #30)

| Claim | Verdict | Evidence |
|---|---|---|
| Incremental mining is real in production; markers exist; the 07-01 run was incremental | CONFIRMED | 24 `incorporated:` markers = all extracted captures; the 07-01 20:42 run summary (captures:24, extracted:3, per-pass shapes, no insights pass) matches the incremental path; telemetry `miner_run/incremental` attrs `{mode:'incremental', new_captures:8}`. |
| Routine mines finish under the 300s in-app cap | NOT TRUE | The only production incremental fold took 779s (13 min). It succeeded only because it ran on the GitHub Action. Every in-app (Vercel, maxDuration=300) mine of this corpus has died as a zombie (3 observed). The under-300s number came from the 6-capture harness clone, not the real corpus. |
| The fold resolves against the existing graph so known entities do not duplicate | NOT TRUE | Two independent breaks: (a) the incremental people/places/facts passes send `canonical_nodes: []` (`incremental.ts:528,542,578`), so the model never sees existing entities, contradicting the design (`docs/incremental-miner.md:119-120` says to feed existing canonical nodes as context); (b) with `MINER_STABLE_IDENTITY` off (live: unset, `entity_aliases` 0 rows) the resolver is null (`incremental.ts:307`) and identity falls back to exact-label hash. Live damage: the 07-01 fold minted Cole, Dad, Lisa, Max, Justin Keading as near-duplicates of existing people, plus duplicate commitments. |
| 3 corrections filed after the last mine force the next run onto the FULL path | CONFIRMED | `incremental.ts:481` fingerprint check vs the stored `incremental:corrections_fp` (07-01 07:58, stale); all 3 pending corrections are people-kind. The full run takes 13-22 min, over every in-app budget, and corrections do not count toward any auto-run trigger, so they are effectively stranded until a manual Action dispatch. |

## Streaming and token settings (PR #29, #30)

| Claim | Verdict | Evidence |
|---|---|---|
| The model call actually streams | CONFIRMED | `anthropic.ts` uses `messages.stream(...).finalMessage()`; SDK 0.104.2's 10-minute refusal lives only in the non-streaming path. Live proof: 07-01 07:21 run failed with the streaming error pre-merge; 07-01 20:42 run (post-merge) completed a 13-minute mine. |
| Hardened token settings applied (PAGE_SIZE 40, MAX_TOKENS 24000) | CONFIRMED | `config.ts` defaults; consumed by `stage-common.ts`; `miner.yml` passthroughs; run-summary usage consistent (people pass 18,810 output tokens under the 24k ceiling, 30 rows in 1 batch under page 40). |
| Miner system prompts cached (padded past 4096, ephemeral) | PARTIAL (low) | `cache_control: ephemeral` is set (`anthropic.ts:49`) but the per-table miner prompts are ~700-1400 tokens, below the model's caching minimum, so most passes cannot cache; run summaries show cache_read=0 on most passes. The chat surface's 4096+ padded prompt (PR #6) is separate and real. Doc-vs-reality gap on the standing rule as applied to the miner. |
| On persistent invalid JSON the pass dies and the run row records the error | CONFIRMED | Batch retry wraps the parse; the 06-30 18:29 run row carries the exact truncation error verbatim. |

## Password recovery (PR #31 merged, PR #32 open)

| Claim | Verdict | Evidence |
|---|---|---|
| The reset page exists with policy parity and a clean expired state | CONFIRMED | `app/reset-password/page.tsx` + `actions.ts` on main. |
| A recovery session landing at the app root routes to /reset-password | NOT TRUE | No code anywhere handles `?code=`, `token_hash`, or fragment tokens at `/`: `app/page.tsx` reads no auth params, the middleware has no such handling, and there is no browser Supabase client to consume fragment tokens (`lib/supabase/client.ts` was deleted in PR #20). An unauthenticated root landing with a code redirects to /login and the code is lost. |
| The empty Supabase redirect allowlist kills the emailed reset link | NOT TRUE (audit's own initial inference, corrected) | GoTrue validates redirect_to by scheme+hostname against site_url (verified in the supabase/auth source, `IsRedirectURLValid`), so `https://memo-phoenix-nu.vercel.app/auth/callback?...` IS honored with the allowlist empty because it shares the site_url host. The emailed link therefore lands on /auth/callback correctly. The allowlist only matters for other hosts. |
| The PR #31 admin recovery link depends on the Supabase redirect allowlist | NOT TRUE (it does not depend on it, as PR #31 designed) | The link is built from `generateLink`'s `hashed_token` as `<site>/auth/callback?token_hash=...` (`app/admin/actions.ts:127-131`) and verified server-side via `verifyOtp`; it never passes through GoTrue's redirect validation and needs no SMTP. This is the one recovery path proven robust under the live config. |
| PR #32's premise: custom SMTP is configured, so self-service delivery is reliable | NOT TRUE | Live auth config: `smtp_host` unset, `smtp_admin_email` unset. Delivery still rides Supabase's built-in rate-limited sender (~2/hr). PR #32's code is enumeration-safe and correct, but if merged as-is its emails will frequently not deliver, which is exactly the failure mode PR #31 was built to avoid. The operator note in PR #32 (configure SMTP) was correct; the premise stated in its docs was not. |

## Graph health and canonical integrity (PR #29's "graph is healthy")

| Claim | Verdict | Evidence |
|---|---|---|
| Graph healthy per user: counts sane, no duplicate groups, no dangling edges | PARTIAL | As of the 06-30 analysis it was true for exact-label duplicates and remains true (0 exact-normalized dup groups in every node table). It is no longer true in the sense that matters to the user: 8+ near-duplicate people clusters are current (Cole/Cole Richards, Dad/Brian, Lisa/Lisa Hennessy, Max/Max States, Justin Keading/Justin Keating, Todd/Todd Gavin, Linnea/Linnea Skinner, Nate/Nate (friend)), 5 minted by the 07-01 fold, plus duplicate commitments (the done "Text Max" task resurfaced as an open duplicate). Dangling edges: 0 of 76 when endpoints are checked against all current node tables including facts (the audit's own earlier "1 dangling edge" was a query that omitted facts as an endpoint table; corrected). One real dangling pointer exists in supersession: person 2aa3a797 has `superseded_by` referencing a row that was never created (see system-audit finding on supersedeLosers). |
| Provenance holds; chain canonical -> raw -> capture resolves | CONFIRMED | 0 rows with null/empty `source_claim_ids` across all 8 canonical tables (current and superseded); sampled chains resolve to raw rows and captures of the same user; no orphan claim ids found. |
| The app never wrote canonical directly | CONFIRMED | Code: no canonical writes outside `packages/miner-core`; corrections actions write `corrections` only; the people overlay is display-only. Data: `canonical_history` bursts align exactly with miner-run windows (06-18, 06-20, 06-28, 07-01); no out-of-window writes. |
| The duplicated 59k capture double-counted claims | CONFIRMED | Two identical-md5 captures (06-30 06:40:03.86 and 06:40:05.78) were independently extracted (46 and 44 raw claims); 9 current people rows cite claims from both copies; salience is provenance-weighted, so the inflation is permanent absent retraction. A second identical pair exists from 06-19 (426 chars, 1.45s apart). |

## Other decision-log claims (sweep)

| Claim | Verdict | Evidence |
|---|---|---|
| Churn reduction: change-signature on {claims, temporality}; superseded rows not resurrected | CONFIRMED | `stage-common.ts` changeSignature + the resurrect-skip branch. |
| Freshness loop real: read-time decay consumed; anchors populated | CONFIRMED | 100% of current rows carry `last_confirmed_at`; decay consumed by retrieval and reconfirm selection; `freshness`/`incremental` telemetry attrs show reconcile counts. |
| Supersession from discrepancies executes | CONFIRMED | 07-01 fold: `superseded: 1` executed from 4 discrepancy items; 9 people / 28 relationships / 2 insights retired historically. Qualifier: the discrepancies TABLE (PR0 aux) has 0 rows; discrepancy content lives only in run summaries (dead aux table, see system-audit). |
| Corrections honored on mine | PARTIAL (medium) | Karalea, Tal->Todd, Bo->Beau applied and visible in current labels. Qualifiers: the Morgan rename produced a dangling `superseded_by` (survivor row never materialized; `supersedeLosers` does not verify); the 3 pending 07-01 corrections are stranded on the full path (above); rename rewrites are label-keyed and ignore the `person_id` in the payload, so the pending bare-name renames ("Nate" -> "Nate Tennant") can catch the wrong person's claims if the model emits another person under the bare label. |
| Capture-with-target honored | CONFIRMED | `extract.ts` prepends the resolved target context line. Low defect: the target resolve does not filter `valid_to is null`, so a target can resolve to a superseded row's label. |
| Interview writes exactly one capture; short sessions not captured | CONFIRMED | The 7 never-ended `interview_sessions` are abandoned/failed-connect residue, not double captures. |
| Companion overlay drift re-match | CONFIRMED | All 4 `companion_state` rows still exact-match current commitments. Qualifier: the 07-01 duplicate commitments sit alongside them (the done task's duplicate shows as open; the overlay correctly refuses to transfer state to a different row). |
| Key isolation | CONFIRMED | Secret values absent from the existing `.next/static`; `lib/supabase/admin.ts` is server-only with no client-reachable importer. |
| Migrations applied via migrate-on-merge CI | NOT TRUE (high, ops) | All 9 `migrate.yml` runs ever are failures (secrets never set); `schema_migrations` internals show 0001-0009 applied via `supabase db push` and 0010-0015 recorded via `scripts/db.mjs` / by hand. The merge-driven migration pipeline described in CLAUDE.md has never once worked end to end. The fallback (`npm run db:apply`) is what actually operates. |
| Background/headless mining exists (daily cron sweep) | NOT TRUE as operated (low once understood) | The cron sweep has never dispatched: all 6 `miner_run_triggered` events are the in-app route; the miner Action's 4 runs are all `workflow_dispatch` (operator-manual), zero `repository_dispatch`. Cannot distinguish "CRON_SECRET/dispatch not configured" from "threshold never crossed" from telemetry (itself an observability gap); either way, no background mine has ever run. |
| docs/memo-goals-and-roadmap.md exists | NOT TRUE | The file does not exist; nearest documents are `docs/memo-phoenix-spec.md` and `docs/buildout-spec-phase2.md`. |

## Corrections to this audit's own preliminary findings

Recorded for honesty, since this project has shipped a confidently-wrong analysis before:

1. The preliminary finding "the empty uri_allow_list breaks emailed recovery links" was WRONG and
   was caught by the adversarial verification pass: GoTrue allows same-host redirect_to values.
2. The preliminary finding "1 dangling relationship edge" was WRONG (the endpoint check omitted
   facts as a node table); the corrected count is 0.
