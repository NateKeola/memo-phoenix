# Work Order: Miner Cost Fix

For a capable coding agent running a long session. Plan first, then execute in checkpointed phases.

**Background reading, required before anything else:** `docs/memo-master-context.md`. This work order references it by section and does not restate it. If that file is not in the repository, stop and tell the operator to commit it before continuing.

**Scope:** Stage A and Stage B of Part VIII, plus Stage D. Nothing else in that document is in scope for this work order, including anything marked V1, V2, Parked, or Open-Exploratory.

---

## The objective, stated in one line

**A rename must cost nothing. Today it costs 31 minutes and about $4.78.**

MEASURED: one `rename_person` filed at 23:52 on 2026-08-07 caused a 30.9 minute, 12 model call, $4.78 full recompute (run `31229780169`). The rename's true blast radius is one row in `canonical_people`. `applyRenameLabels` already performs that relabel with zero model calls. It is trapped behind a full recompute purely because of where it is called and what the corrections fingerprint does to the mode branch.

That gap is the entire target of this work order.

---

## Standing rules that gate every phase **[Locked]**

Read Part IV of the context document in full. The ones most likely to be violated here:

1. **Branch off main. Open a PR. Never merge.** A human merges. Branch protection and a pre-push hook will refuse a direct push; do not attempt to work around either.
2. **Before any push, run `git branch --show-current` and state it.** If it is main, stop and branch.
3. **Every PR updates `docs/HANDOFF.md` and appends a dated `CLAUDE.md` decision entry** in the same diff.
4. **The miner is the only writer of the canonical graph.** This work order changes when the miner writes, never who writes.
5. **Anything persisted to a database column is shaped.** Ids, counts, durations, enums. Model output and entity labels go to stdout only.
6. **Any check that enumerates must report its denominator.** State how many of how many, every time.
7. **Additive migrations only.** If any phase here needs a destructive migration, stop and report rather than writing one. Next free number is 0023.
8. **No em dashes** anywhere, including PR bodies and commit messages.
9. **Do not run the miner.** The agent cannot. Every mine is the operator's, and each full recompute costs real money.

---

# PHASE 0: Investigate and plan. No code.

Produce a plan document at `docs/plans/miner-cost-fix-plan.md`. Commit it on a branch, open a PR containing only that file, and **stop**. Do not begin Phase 1 until the operator responds.

## 0.1 Answer O-1, the blocking question

**Question:** can the rename force-write and the `resolveSurvivorIds` ordering be satisfied outside a derivation run?

Context, from the audit. `applyRenameLabels` runs after the people pass because it is a force-write that must beat `changeSignature`, which deliberately excludes the label, so a pure relabel is otherwise classified `unchanged` and never written (`derive.ts:605-612`, `stage-common.ts:386-388`). It must run after because `resolveSurvivorIds` reads rows the people pass just wrote, and before `aNodes` is read so later stages see the corrected label. Git history confirms it is a bug fix, not a design: `328ebeb`.

Answer with quoted code and git history, covering:

- What exactly does `resolveSurvivorIds` read, and does every row it needs already exist in the graph before any pass runs, or only after the people pass writes?
- For a `rename_person` where the target row already exists and its claim set has not changed, is there any state the people pass produces that the relabel depends on?
- For a `merge_people`, same question, plus: is the affected set fully enumerable from the payload's `from_id` without a derivation pass?
- Does anything downstream of the relabel depend on it having happened inside a derivation run rather than as a standalone operation?

**If the answer is that either correction genuinely cannot be applied outside a derivation run, stop. Report why, with evidence, and propose no partial version.** A half-built corrections-only path that silently reverts renames is worse than the current cost.

## 0.2 Establish the baseline

Report, all read-only, with denominators:

- Current pending corrections: how many, of what kinds, and the stored versus recomputed fingerprint.
- Current live row counts per canonical table.
- The `miner_runs` history for the last 45 days: mode, outcome, duration, calls, cost.
- What the Memory screen currently shows for run mode and for retirement.

This is the before picture. Phase 2's acceptance is measured against it.

## 0.3 Write the plan

The plan document must contain:

- The O-1 answer, stated as a conclusion with its evidence.
- A per-phase breakdown with the exact files and functions each phase touches.
- For Phase 2, the specific mode branch change and where the fingerprint advance moves to.
- Acceptance criteria per phase, split into what the agent can verify and what only the operator's live mine can prove.
- A rollback statement per phase.
- Every assumption the plan rests on, marked as an assumption.

**Then stop.**

---

# PHASE 1: Legibility. One PR. Zero behaviour change.

Context document Stage A. This ships first because it changes nothing and because Phase 2 is unverifiable without it.

## 1.1 Distinguish "nothing qualified" from "the cap refused"

`retireAbsorbedRows` currently returns `{retired: 0}` in both cases (`stage-common.ts:533`, returned at both line 545 and line 554). The only distinguishing evidence is a `console.warn` that exists solely in the GitHub Actions log.

Return a distinct value. Carry it into the pass result and into `miner_runs.summary`. Surface it on the Memory screen so the operator can see, from inside the app, whether the graph is converging or accumulating.

**Do not raise the cap.** It refused three times, once by two rows, and it exists because a mass retirement is unrecoverable in a single run. Raising it is a separate decision with its own PR.

Whatever lands in `summary` must be shaped: counts and enums, never table names concatenated with model text, never row labels.

## 1.2 Instrument the resolver

Return a tier discriminator from `Resolver.resolve`, one of `exact | alias | fuzzy | context | mint`. Accumulate a per-pass histogram in `runNodePass` and add the five counts to the `miner_run` telemetry attrs that `record()` already emits at `derive.ts:541`.

The audit calls this the single highest-value missing measurement in the system, and Stage C cannot be evaluated without it.

Additive only. No change to resolution behaviour, no change to thresholds, no change to the ladder order.

## 1.3 Acceptance

**Agent verifies:** `tsc --noEmit` clean, lint clean, build succeeds, `npm run security` 8 of 8 with the harness unmodified except for any new telemetry attr names in the privacy assertion. `git diff --stat -- supabase/migrations/` empty. Confirm in the PR body that no resolution threshold, page size, prompt, or model config appears in the diff.

**Operator verifies, on the next mine:** the resolver histogram appears in telemetry, and the Memory screen distinguishes a refused retirement from a clean one. State in the PR that this is pending and unverified by the agent.

---

# PHASE 2: Corrections stop forcing a full recompute. One PR. This is the cost fix.

Context document Stage B. Gated on the O-1 answer from Phase 0.

## 2.1 What changes

Today the mode branch is: full if no baseline exists **or if the corrections fingerprint changed**, otherwise incremental. The second condition is what turns a rename into a $4.78 event.

Route `rename_person` and `merge_people` through their existing pure graph operations: `applyRenameLabels`, `supersedeLosers`, `retireStaleRelationships`, `repointReferences`. Advance the corrections fingerprint. Run no derivation passes. Record mode `corrections_only`.

## 2.2 Constraints **[Locked]**

- **Atomicity.** The fingerprint advance is the last write. Graph operations complete first. The state of an advanced fingerprint with the relabel unapplied must be unreachable by construction, not merely unlikely. Any failure leaves the fingerprint stale so the next mine retries. This requires every graph operation to be idempotent, which is an acceptance criterion, not an assumption. *(Amended 2026-08-14 by operator ruling, adopting the Phase 0 plan's Option B; the original read "in a single transaction", which the PostgREST client cannot provide without a plpgsql migration. See `docs/miner-cost-fix-plan.md` 4.2.)*
- **Correction kinds that genuinely need derivation still force it.** If the O-1 investigation shows one of them does, say so plainly with evidence and let it force a full. Do not force a full defensively for both because one is uncertain.
- **The mode value is visible.** `corrections_only` appears in `miner_runs`, in the observability console, and on the Memory screen's run-mode chip. The operator must be able to see that it cost nothing.
- **The next ordinary mine must still produce a correct graph.** The old label is kept as an alias; confirm the graph remains correct on the following mine given that.
- **No migration** unless the new mode value requires one. If it does, it is additive, number 0023, and it is called out in the PR body.

## 2.3 What must not change

Page sizes, model configuration, effort, thinking settings, prompts, validation rules, retry behaviour, the resolver ladder, the retirement cap, the claim-handle scheme, or anything in the extraction path.

## 2.4 Acceptance

**Agent verifies:** the same static checks as Phase 1, plus an explicit statement of which correction kinds now take the `corrections_only` path and which still force a full, with the reason for each.

**Operator verifies, live, in this order:**
1. File one `rename_person`.
2. Run one mine. It must complete in seconds, make zero model calls, record mode `corrections_only`, and cost approximately zero.
3. Confirm the rename is visible in People.
4. Run a second mine with no new captures. It must be a no-op.
5. Record a new capture, run a mine, confirm it goes incremental and the renamed label survives.

**Report in the PR body:** before and after cost and wall clock for a single rename, using the Phase 0 baseline. The before figure is 30.9 minutes and $4.78.

---

# PHASE 3: Route interview captures through `writeCapture`. One PR. Small.

Context document Stage D and section 28.

`captures` has 12 `.from('captures')` sites, 2 of which are inserts, and **only one goes through `writeCapture`**. `app/api/interview/end/route.ts:83` inserts directly, so interview transcripts get neither the 100,000 character cap (`lib/captures.ts:38`, enforced at `:57`) nor the 10 minute content-dedup window (`:44`, enforced at `:66`).

Interview transcripts are the longest capture type in the system and are the only type with no length cap and no double-submit guard. **Two of the four duplicate captures the 2026-07-02 repair had to retract were this exact failure mode.**

Route it through `writeCapture`. Then report the denominator: how many capture write paths exist, and how many now go through the guarded function. The answer should be 6 of 6.

**[Open-Blocking]:** if an interview transcript can legitimately exceed 100,000 characters, say so with a measured maximum from live data before changing the cap, and do not change it in this PR.

---

## Stop conditions

Stop and report, rather than proceeding, if any of these occur:

- The O-1 investigation concludes a correction cannot be applied outside a derivation run.
- Any phase would require a destructive migration.
- `npm run security` drops below 8 of 8 for any reason other than a deliberate, stated, in-flight data fix.
- A change would touch the resolver ladder, the retirement cap, page sizes, or model configuration.
- The work would need more than one PR per phase.
- Anything contradicts a MEASURED number in the context document. Report the contradiction; do not quietly build on the newer number.

## What is explicitly out of scope

Stage C (claim-overlap tier), Stage E (retirement batching), Stage F (persisting discrepancies), Stage G (consent gate and `derivation_version`), Stage H (bounding the incremental payload), Phase 1 of the scope migration, every feature in Part IX, every surface in Part X, and everything in Parts XI through XIII.

Stage H in particular: at 529 rows an in-memory scan is adequate and no retrieval index will pay for itself. It is deferred deliberately, with a stated trigger condition. Do not build it because it looks like the obvious next optimisation.

## Closing instruction

Phase 0 is a plan, not a preamble. Its output is a committed document and a stopped session. The operator will read it and respond before Phase 1 begins.

Each subsequent phase is one PR, and the session stops after opening it. The operator merges, runs the live verification, and reports back. Do not chain phases without that checkpoint, and do not open more than one PR per phase.
