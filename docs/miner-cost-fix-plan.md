# Miner cost fix: Phase 0 plan

Phase 0 output of `docs/fable-work-order-miner-cost.md`, produced under
`docs/fable-wo1-orchestration.md`. Investigation ran 2026-08-14 as seven
read-only briefs in one parallel wave against main at 66e2440, database
read-only, no miner run. Wave completion: 7 of 7 briefs returned, zero
failed, zero empty, zero narrative rejections. Evidence below carries the
briefs' file:line citations; MEASURED means a file:line, git sha, or query
result exists.

## 1. The O-1 answer, the Phase 2 gate

**Both correction kinds can be applied outside a derivation run. Phase 2
proceeds for both `rename_person` and `merge_people`.** No kind needs to
keep forcing a full recompute.

### rename_person: YES

The four work-order 0.1 questions, answered from brief I-1 (all MEASURED):

- Q1 what resolveSurvivorIds reads: exactly one query, current
  `canonical_people` rows (`corrections.ts:178-186`,
  `.select('id, label').eq('user_id', userId).is('valid_to', null)`), plus
  the in-memory map built from the corrections table
  (`corrections.ts:148-159`). Measured live: of 14 rename edges chained to
  fixpoint, 9 resolve to the loser row itself (skipped at
  `corrections.ts:197`), 3 to a distinct pre-existing current row, 2 to no
  current row. Zero of 14 depend on a row only a pass could create.
- Q2 pass state dependence: none. The case the force-write exists for, an
  in-place relabel with an unchanged claim set, is precisely the case where
  the people pass writes nothing (`changeSignature` excludes the label,
  `stage-common.ts:386-388`; `writeCanonical` classifies the row unchanged).
  `applyRenameLabels` reads only current rows by the payload id
  (`corrections.ts:249-254`) and writes label, first/last, and an alias
  union computed from the row's own pre-existing data
  (`corrections.ts:260-266`). Confirmed by the introducing commit `328ebeb`.
- Q3 affected set: one row, identified by the payload `person_id`
  (`app/people/actions.ts:32-36` stamps it; `corrections.ts:102-106`
  consumes it). Measured: 19 of 19 live corrections carry the targeted id,
  so the label-hash fallback is never exercised for this user.
- Q4 downstream dependence on running inside a derivation: none. The aNodes
  context read (`derive.ts:615-618`) is a plain current-rows SELECT; the
  pending-rename overlay clears on label equality, not on a run
  (`lib/people.ts:72`); the rewrite is rebuilt from the corrections table on
  every run independent of the fingerprint (`derive.ts:569-570`, applied at
  `derive.ts:188` and `incremental.ts:359`), so a standalone apply that
  advances the fingerprint does not stop future mines from routing new
  mentions correctly; and the `derive:canonical_people` memo hash contains
  the old fingerprint, so a later full recompute cannot falsely memo-skip.

Boundary case, resolved: a rename to a label that matches no current row
(brief I-1's case c) needs no survivor row at all. `resolveSurvivorIds`
correctly skips it (`corrections.ts:190-196`) and the in-place relabel via
`applyRenameLabels` is the complete operation.

### merge_people: YES

- Q1: the survivor (into) row always exists before any pass, because the UI
  only offers current rows as merge targets
  (`components/person-corrections.tsx:53-67` builds `intoId: keep.id` from
  the live list; `lib/people.ts:123-127` is current-only). Measured: 5 of 5
  merge payloads carry `into_id` and all 5 rows are currently live.
- Q2: `supersedeLosers` (`corrections.ts:218-225`), `retireStaleRelationships`
  (`corrections.ts:284-292`) and `repointReferences`
  (`corrections.ts:318-346`) are each fresh current-rows scans keyed on
  loser ids; no pass result object crosses into any of them (I-1 finding
  PASS-STATE: the only inter-function state is committed row state, read
  back through ordinary SELECTs).
- Q3: the full affected set (loser row, survivor row, stale edges, embedded
  references in commitments/projects/events/insights) is enumerable from
  ids against the live tables with no pass. One measured caveat: the miner
  never reads `into_id` (exactly one repo hit, the comment at
  `corrections.ts:103`); the survivor is resolved by normalized label with
  the fixpoint chain. Measured: raw `into_label` matches only 3 of 5 today,
  the chained label matches 5 of 5. The existing operations work standalone;
  the unread `into_id` is recorded under found-not-fixed.
- Q4: none. The pending overlay ignores merges entirely
  (`lib/people.ts:48`, `.eq('kind', 'rename_person')`); a merge surfaces
  purely through the loser leaving the current set. The one load-bearing
  ordering is INTERNAL to the corrections block, not relative to any pass:
  resolveSurvivorIds, then supersedeLosers, then applyRenameLabels, because
  the relabel relies on merge losers already being superseded so its
  valid_to filter skips them (`derive.ts:606-611`, commit `c772795`).

## 2. Contradictions with MEASURED master-context numbers (rule 4.3)

Three found. Both figures and both sources for each; neither averaged;
nothing below builds on either figure without saying which.

**C1, retirement return sites: 2 asserted, 4 measured.** Master context s23
describes the defect as returning `{retired: 0}` "both when nothing
qualified and when the cap refused" (two cases). Measured (brief I-4):
FOUR return-none sites, all present since the function's creation in
`bf74bd6` (2026-07-01): `stage-common.ts:534` (env kill switch
`MINER_RETIRE_ABSORBED === '0'`), `:546` (zero live rows), `:559` (nothing
qualified), `:567` (cap refused). PR #51 added none of them and changed
nothing inside the function; it shifted it uniformly +14 (`git show 9534ed2
--numstat`: 15 insertions 1 deletion, all above line 262). The documented
"+13" offset was the audit citing a closing brace: at `9534ed2^`, line 553
is `return none` and 554 is the `}`. The 2026-08-08 audit under-enumerated
2 of 4, which is process-rule 15.6 firing on the audit itself. Affects:
Stage A-1's scope (section 4.1 below designs for the four sites plus one
out-of-function state, not two).

**C2, capture census: 12 sites / 2 inserts asserted, 15 / 4 measured.**
Master context s28 asserts "12 `.from('captures')` sites, of which 2 are
inserts." Measured (brief I-5, .ts AND .tsx AND .mjs, excluding
node_modules): 15 sites, 11 reads and 4 inserts. The audit's grep used
`--include='*.ts'` only and so missed `app/page.tsx:18` (a read), and its
count excluded `scripts/` (harness clone insert at
`incremental-equivalence-harness.ts:147`) while missing `seed.ts:35` (a
direct insert inside the miner package, within the audit's own claimed
scope). The app-facing figures survive: 6 app write paths, 5 through
`writeCapture`, 1 direct (`app/api/interview/end/route.ts:83`). The full
insert-capable surface is 8 paths, 5 guarded. Affects: Phase 3's
denominator claim (section 4.3 below states 6 of 6 app paths as the
acceptance figure and names the 2 non-app direct inserts).

**C3, "interview transcripts are the longest capture type": refuted by
live data.** Master context s28 asserts it. Measured (brief I-5, all
users): longest interview capture is 12,302 chars (12.3 percent of the
100,000 cap; n=45, p95=10,412); the longest capture of any kind is an
85,182-char `text` capture. Interview is not the longest capture type in
the live corpus. Affects: Phase 3's rationale, not its action. The
incident basis stands unchanged (2 of the 4 duplicates in the 2026-07-02
repair were interview double-submits), and the work order's Open-Blocking
question "can a transcript legitimately exceed 100,000 chars" is answered:
no live transcript is within a factor of 8 of the cap; the cap is not
changed in this work order.

One refinement that is NOT a contradiction: master context s19 says
"nothing records which tier resolved a claim." Still true of recording,
but the discriminator already exists in the return type:
`resolution.ts:32` `export type ResolveVia = 'exact' | 'alias' | 'fuzzy' |
'mint'`, returned at `:186`, discarded by all 3 of 3 call sites
(`derive.ts:202`, `derive.ts:480`, `incremental.ts:368`). Stage A-2 is
plumbing plus one labeling decision, not new resolution logic.

## 3. Baseline (Phase 2 acceptance is measured against this)

All from brief I-7, read-only queries, user MEMO_USER_ID
(691c75b5-...), 2026-08-14:

- Pending corrections: **zero**. 19 rows total (14 rename_person, 5
  merge_people, only kinds present, 19 of 19 examined). Stored fingerprint
  `253d0059dcb87441...` equals the recomputed fingerprint (recomputed with
  the real `canonicalJson`/`sha256` from `identity.ts` via tsx over all 19
  rows ordered created_at asc). `correctionsChanged` is false today.
- Live canonical rows: **529**, matching master context s20 table for
  table (people 68, places_orgs 85, projects 27, events 52, facts 110,
  commitments 39, relationships 75, insights 73). 8 of 8 tables counted.
- miner_runs, last 45 days: **14 runs, 7 done, 7 error** (12 trigger
  manual, 1 onboarding, 1 cli). Only the last two carry llm_call telemetry:
  2026-08-07 22:54 full/done 2,297s 20 calls $6.2209; 2026-08-08 00:20
  full/done 1,851s 12 calls $4.7834. Cost for the other 12: NOT DETERMINED,
  data never recorded. No run in the window has mode incremental or noop.
- The reference "before" figure for one rename, per the work order: the
  2026-08-08 run, 30.9 minutes, 12 calls, $4.78.
- Memory screen today: renders a mode chip per ledger row
  (`components/miner-control.tsx:213-219`), with unknown mode strings
  falling through to "full"; renders **no retirement information of any
  kind** (grep across lib/app/components: zero canonical-retirement reads;
  `summarizeChanges` folds only inserted/updated/unchanged).

## 4. Per-phase breakdown

### 4.1 Phase 1, Stage A, legibility. One PR. Zero behaviour change.

**A-1, retirement signal.** Design (from I-4 finding 2, judgment marked
ESTIMATE there, adopted here): a `retirement` object on the pass result
with a three-member reason enum plus counts,
`{ outcome: 'none_qualified' | 'cap_refused' | 'disabled', qualified,
cap, current, retired }`. Sites `:546` and `:559` collapse into
`none_qualified` (the empty-table case is `current: 0`, already separated
by the counts); `:534` stays distinct because it is a configuration state
not a graph state; `:567` stays distinct because it is the only site where
rows qualified and were abandoned. The fourth state, a memo-skipped pass
that never calls `retireAbsorbedRows` (`derive.ts:105` returns early;
measured live: skipped passes carry no `retired` key at all), renders as
"not attempted", distinct from "attempted, zero".

Files and functions: `stage-common.ts` `retireAbsorbedRows` (return the
object at all four sites), `types.ts` `PassResult` (add the field),
`derive.ts` all 5 call sites of retireAbsorbedRows (thread it), `run.ts`
none (summary flows through `shapedSummary`, a denylist that only strips
`discrepancyItems`, `run.ts:174-182`), `lib/miner/state.ts`
(`MineSummaryShape.passes`, `summarizeChanges`, `LedgerRun`),
`components/miner-control.tsx` (ledger line), optionally
`app/admin/observability/page.tsx`. Shaped per 14.5: enum plus four
integers, never table-concatenated text, never row labels.

**A-2, resolver histogram.** `Resolver.resolve` already returns
`{ id, via, isNew }`. Two sub-changes: (1) split `via: 'context'` out of
`'fuzzy'` at `resolution.ts:117-126`, where `bothCtx` is already known, a
label-only change with zero threshold or ordering effect, giving the
five-member enum Stage A-2 names; (2) count `via` per pass in
`runNodePass` / `runInsightsPass` / `incNodePass` (the 3 of 3 call sites),
carry `tiers: { exact, alias, fuzzy, context, mint }` on `PassResult`, add
the five counts to the attrs `record()` emits (`derive.ts:541-565`,
current shape 13 shaped keys, quoted in brief I-3). The five counts sum to
resolution attempts, stated per 15.6.

Incremental visibility (I-3 finding 4, MEASURED): the incremental path
emits NO per-pass miner_run telemetry, so counts landing only in
`record()` would be invisible on incremental runs. Phase 1 also adds the
aggregated five counts to the existing incremental whole-run miner_run
event (`incremental.ts:704-717`).

Harness impact: **zero files** (I-6 findings 6 and 7, MEASURED). The only
attr whitelist is SQL-scoped to `event_type = 'llm_call'`
(`check-obs-db.mjs:190-193`); `mp_summary_has_content` inspects only
`passes[].discrepancyItems` (migration 0022:127-137); `mp_attrs_has_content`
keys solely on `routing_hint` (0022:159-165). Constraint: the tier counts
must NOT be added to `llm_call` attrs, or `LLM_CALL_ATTR_KEYS` in both
`call-telemetry.ts` and `check-obs-db.mjs:154-160` would need extending.

No migration. `git diff --stat -- supabase/migrations/` stays empty.

### 4.2 Phase 2, Stage B, corrections stop forcing a full. One PR.

**The mode branch change**, at `incremental.ts:545`. Today:
`if (!baselineExists || correctionsChanged) -> full`. After: full only if
`!baselineExists`; when `correctionsChanged && baselineExists`, take a new
`corrections_only` path. Design decision (marked as such): the
corrections_only run applies corrections and stops; it does NOT fold
pending captures in the same run. A correction plus new captures costs two
runs (corrections_only, then incremental), matching the work order's
five-step acceptance sequence and keeping the mode value honest. The
alternative (apply corrections then continue into the incremental branch
in one run) is noted and not chosen.

**What the corrections_only path runs** (I-2 finding 6, all quoted there):
`readPeopleCorrections` + `buildPeopleRewrite` (already at
`incremental.ts:537-538`), then the existing five operations in the
existing internal order: `resolveSurvivorIds`, `supersedeLosers`,
`applyRenameLabels`, `retireStaleRelationships`, `repointReferences`
(today at `derive.ts:601, 602, 612, 681, 682`), then the fingerprint
advance `setState(userId, CORR_FP_SCOPE, peopleRewrite.fingerprint)`
(moves from `incremental.ts:549`, where it runs only after a full
derivation, into the new branch), then a `corrections_applied`-equivalent
telemetry event and the miner_runs mode stamp and terminal summary
(`run.ts:277`, `:288-290`). What it skips: all 8 derivation passes, all 6
per-pass memo writes, `persistAliases`, `retireAbsorbedRows`,
`markIncorporated` (marking any unincorporated capture here would silently
lose it, I-2 F6), and the freshness tail (`derive.ts:709-714`).

**The atomicity constraint 2.2, an Open-Blocking decision.** Measured
(I-2 finding 4): a multi-statement transaction is NOT mechanically
available. The miner client is supabase-js over PostgREST, one HTTP
request per statement; the repo has ZERO `.rpc(` call sites; strict
"one transaction" compliance requires a new Postgres function via an
additive migration (next free number 0023) reimplementing the five
operations plus the fingerprint upsert in plpgsql. Options, position
taken:

- Option A, strict: migration 0023, plpgsql function, `.rpc()` call.
  Cost: reimplementing five TypeScript functions in SQL, the largest
  correctness risk in this work order.
- Option B, recommended: fail-safe ordering without a transaction. Graph
  operations first, fingerprint last. A crash between them leaves the
  fingerprint stale with corrections applied; the next run re-enters the
  corrections path and re-applies, and all five operations are idempotent
  (documented at `corrections.ts:312-313` and measured by I-1: re-running
  reaches the same rows). The dangerous state, fingerprint advanced with
  the relabel unapplied, is unreachable under this ordering. The
  transient state self-heals on the next mine. This satisfies 2.2's
  intent (never a silently reverted rename) but not its letter ("in a
  single transaction"), and 2.2 is [Locked], so this choice is the
  operator's. The current full branch has exactly the same non-atomicity
  today (three bare awaits, `incremental.ts:547-549`, no rollback).

**Mode value**: no migration (I-2 finding 5, MEASURED). `miner_runs` has
no mode column; mode lives in the `summary` jsonb (`0013:55-71` quoted,
no CHECK constraint). Touch: the union type `incremental.ts:515`, the two
UI label fall-throughs that would otherwise render `corrections_only` as
"full" (`components/miner-control.tsx:216-218`,
`app/admin/observability/page.tsx:174-176`), and the permissive
passthrough `lib/miner/state.ts:111` (no change needed).

Harness impact: zero (I-6 finding 8: no run-mode string exists in any of
the 8 surfaces).

### 4.3 Phase 3, Stage D, interview captures through writeCapture. One PR.

Route `app/api/interview/end/route.ts:83` through `writeCapture`. One
implementation fact the census surfaced: `writeCapture`'s insert
(`lib/captures.ts:85-97`) does not carry `interview_id`, which the direct
insert sets from `body.sessionId`. Phase 3 adds an optional `interviewId`
input to `writeCapture` (additive; passed through to the insert), then
replaces the direct insert. Guards gained: the 100,000-char cap
(`lib/captures.ts:38`, enforced `:57`) and the 10-minute identical-body
dedup (`:44`, enforced `:66`, compares the 10 newest rows in-window),
which is precisely the double-submit failure from the 2026-07-02 repair.
Side effect gained: the `capture` telemetry event (`:102-118`), which the
direct path never logged. The interview route keeps its own
`interview_ended` event; both will fire, stated in the PR.

Cap decision per the work order's Open-Blocking item: measured max
interview transcript is 12,302 chars, 12.3 percent of the cap; the cap is
not changed. Acceptance denominator after the change: 6 of 6 app write
paths through `writeCapture`. The 2 non-app direct inserts
(`packages/miner-core/src/seed.ts:35`, service-role CLI seed;
`scripts/incremental-equivalence-harness.ts:147`, harness clone) are out
of Stage D's scope and stay direct, stated so the 8-path denominator is
honest.

## 5. Acceptance criteria per phase

**Phase 1.** Agent-verifiable: tsc clean, lint clean, build green,
`npm run security` 8 of 8 with the harness untouched, migrations diff
empty, PR body states no resolution threshold, page size, prompt, or model
config in the diff, and the five tier counts sum to attempts on the pass
result type. Operator-live (the only proof, per master context s3): on the
next mine, the resolver histogram appears in miner_run telemetry per pass
(and aggregated on incremental runs), and the Memory screen distinguishes
cap_refused from none_qualified from not-attempted.

**Phase 2.** Agent-verifiable: same static checks; an explicit statement
that BOTH kinds take the corrections_only path with the O-1 evidence
above; the ordering (ops before fingerprint) visible in the diff.
Operator-live, the work order's five steps: file one rename; mine
completes in seconds with zero model calls, mode `corrections_only`,
approx zero cost; rename visible in People; second mine is a no-op; new
capture then mine goes incremental and the renamed label survives. Report
before/after against the baseline: 30.9 min and $4.78 to seconds and
approx $0.

**Phase 3.** Agent-verifiable: static checks; census re-run shows 6 of 6
app write paths guarded. Operator-live: complete an interview, confirm the
capture lands with `interview_id` set, and a duplicate end-callback within
10 minutes creates no second capture.

## 6. Rollback per phase

- Phase 1: revert the PR. No data change; new summary fields and telemetry
  attrs simply stop being written; existing rows unaffected.
- Phase 2: revert the PR. The branch returns to corrections-force-full.
  Any corrections already applied standalone remain applied and are
  idempotently re-covered by the next full recompute; the fingerprint
  mechanism is unchanged in meaning, so no state repair is needed.
- Phase 3: revert the PR. Interview inserts return to the direct path;
  captures written through writeCapture in the interim are ordinary
  captures and need nothing.

## 7. Assumptions and NOT DETERMINED, consolidated (rule 4.2)

Assumptions the plan rests on, each marked:

- A1: `MINER_INCREMENTAL` resolves to '1' on the Action
  (`miner.yml:54`, `vars.MINER_INCREMENTAL || '1'`), so the mode branch is
  live in production. MEASURED at the workflow file; the live repo-var
  value is not readable from here.
- A2: `MINER_STABLE_IDENTITY` defaults on (`resolve-store.ts:19`); the
  Action env does not override it. Same caveat (I-1 ND 4).
- A3: The corrections_only design choice (apply and stop, no same-run
  fold) is a design decision made here, not a measured fact (I-2 ND 1
  raised it; section 4.2 decides it).
- A4: The atomicity recommendation (option B) awaits the operator's ruling
  because constraint 2.2 is [Locked] as written.
- A5: cost attribution rates are the Opus 4.8 list rates used throughout
  (in 5, out 25, cache write 6.25, cache read 0.50 per MTok).

NOT DETERMINED, from the briefs, 15 items of 15 carried (none dropped;
resolved-cross-brief items noted as resolved):

1. Whether resolveSurvivorIds ever matched a same-run pass-created row in
   production history (I-1; canonical_history not queried; does not gate
   the O-1 answer).
2. Whether the 2 rename edges whose chained label matches no current row
   are stuck or satisfied-then-retired (I-1).
3. Whether a standalone apply leaves the observability console
   misreporting corrections counts, since `corrections_applied` is emitted
   only inside runDerivation today (I-1; Phase 2 adds an equivalent
   emitter, section 4.2).
4. Live Action env values for the two flags (I-1/I-2; assumption A1/A2).
5. Whether any live summary rows carry a mode outside the current union
   (I-2; the UI fall-through renders such rows as "full").
6. Whether any non-PostgREST transaction surface exists outside
   application code (I-2; migration tooling not inventoried).
7. The intended ordering of 2.2's two writes (I-2; section 4.2 takes
   ops-first as the recommendation, operator decides).
8. Live miner_run attr key sets as persisted (I-3; emitter-shape claim is
   from source).
9. Whether any admin component renders attrs generically with a fixed key
   list (I-3).
10. Whether the five-member tier enum was intended to require the
    context/fuzzy split (I-3; section 4.1 decides yes, label-only).
11. Which of the four sites produced run 81b518d5's two `retired: 0`
    values (I-4; the column cannot say; Actions stdout is off-machine).
12. Whether Actions log retention still holds the retirement SKIPPED lines
    for 2026-08-08, i.e. whether the current backlog is recoverable
    without a run (I-4).
13. Whether observability_events carries per-pass retirement attrs (I-4;
    scoped out of its brief).
14. Whether any capture insert exists outside the JS/TS surface, raw SQL
    or RPC (I-5; census covers JS/TS only).
15. Costs of the 12 pre-instrumentation runs; and whether the 2026-08-07
    00:15 error run made calls that died before telemetry (I-7; the data
    was never recorded).

Resolved cross-brief: I-6's "does B require a migration" is answered no by
I-2 finding 5. I-6's "what shape should A-1 carry" is answered by I-4
finding 2, adopted in section 4.1.

## 8. Found, not fixed (outside WO-1 scope, listed per orchestration s6)

1. `merge_people.into_id` is never read by the miner; survivor resolution
   is by chained label only (`corrections.ts:103` comment is the sole repo
   reference). Robustness gap; Phase 2 deliberately keeps the existing
   operations unchanged.
2. `lib/telemetry.ts:7` describes attrs as `stage, rows_in, rows_out`, a
   stale comment the emitter has diverged from (I-3).
3. The committed audit document's A6 cites the cap return at :568 and a
   "+13" offset; both stem from citing a closing brace at the pre-#51 sha
   (I-4 finding 4). The master context inherits the two-case framing
   corrected in C1.
4. The interview-end path also skips the `capture` telemetry event, a
   third bypass beyond the two guards; fixed incidentally by Phase 3.
5. Two non-app direct capture inserts exist (`seed.ts:35`,
   `incremental-equivalence-harness.ts:147`), bypassing all guards by
   design; named for the 8-path denominator.
6. The mode-label fall-through renders any unknown mode as "full" in two
   components; Phase 2 touches both, but the fall-through pattern itself
   remains for future mode values.
7. Master context s28's "12 sites / 2 inserts" census was produced by a
   grep with `--include='*.ts'` that silently excluded `.tsx`, the same
   truncation class rule 15.6 exists for; C2 carries the corrected
   figures.
8. The 2026-08-07 00:15 error run at stage canonical_people with zero
   llm_call rows cannot be classified between zero-calls and
   lost-telemetry (I-7).

## 9. Stop conditions checked

Work order stop conditions, 6 of 6 evaluated: no destructive migration
anywhere in this plan; `npm run security` untouched at 8 surfaces; no
resolver-ladder, cap, page-size, or model-config change (the A-2 enum
split is a return-label addition with thresholds and ordering untouched);
one PR per phase; the O-1 investigation did NOT conclude impossibility;
the three MEASURED contradictions are reported above under 4.3 rather
than built upon.
