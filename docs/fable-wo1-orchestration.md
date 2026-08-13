# Fable Session Orchestration: WO-1

Version 1, 2026-08-11. Governs **how** the WO-1 session runs. It does not restate **what** WO-1 builds.

> **Reading instructions.**
> **[Locked]** items are constraints, implement as written. **[Open-Blocking]** must be resolved with the operator before code depends on them. **[Open-Exploratory]** wants options surfaced, not chosen. Untagged means Open-Blocking; ask.
> Do not treat unmarked structure, headers, bullets or prose, as license to expand scope beyond tagged items.

## Required reading, in this order

1. `docs/memo-master-context.md`
2. `docs/work-orders/miner-cost-fix.md`
3. This document

If either of the first two is not in the repository, **stop** and tell the operator to commit them before continuing.

## What this document adds and does not add

The work order defines the objective, the four phases, the acceptance criteria and the stop conditions. **All of that stands unchanged.**

This document adds four things the work order does not cover: the session mode discipline, the sub-agent contract, the Phase 0 investigation roster, and the synthesis rules that stop a sub-agent's summary from becoming a fact.

**Where the two conflict, the work order wins on scope and this document wins on process.**

---

# 1. Session mode **[Locked]**

## 1.1 Phase 0 runs in plan mode start to finish

Every read, every sub-agent dispatch, every piece of analysis in Phase 0 happens in plan mode. **No file is written, no branch is created, no command with a side effect is run** while Phase 0 is in progress.

This is not a preference. Phase 0's entire output is a judgment about whether a correction can be applied outside a derivation run. An agent that has already started writing the corrections-only path while investigating has an interest in the answer being yes.

## 1.2 Exiting plan mode authorizes exactly one action

When Phase 0's investigation is complete, exiting plan mode authorizes this and nothing else:

1. Create a branch off main. State the branch name.
2. Write `docs/plans/miner-cost-fix-plan.md`.
3. Update `docs/HANDOFF.md` and append a dated `CLAUDE.md` decision entry in the same diff.
4. Commit, push, open a PR containing those three files only.
5. **Stop the session.**

Approving a plan is not approving the work the plan describes. **Do not begin Phase 1.** The operator reads the plan and responds.

## 1.3 Phases 1, 2 and 3 each repeat the pattern

Re-enter plan mode at the start of each phase. Investigate. Present the change set. Exit plan mode only to write that phase's single PR, then stop again.

## 1.4 Why both plan mode and a committed document

Plan mode is the enforcement mechanism; it guarantees the investigation writes nothing. The committed document is the artifact; it survives the session ending and is reviewable as a diff. **Neither substitutes for the other.** A plan that lives only in a session context is lost when the session is lost, and this project's working loop is explicitly one where the operator reads an artifact between every phase.

---

# 2. The sub-agent contract **[Locked]**

## 2.1 Sub-agents are read-only. The parent is the sole writer.

No sub-agent writes a file, creates a branch, runs a migration, edits the harness, or runs any command with a side effect. Sub-agents read code, read git history, and run read-only queries.

This is invariant 14.1 applied to process. One writer prevents two problems: parallel edits on one branch, and a sub-agent committing something the parent never weighed against the invariants.

## 2.2 Every return is an evidence table, never a narrative

**This is the most important rule in this document.** A sub-agent that returns prose has summarized, and summarizing is where the denominator dies. Rule 15.6 exists because three separate artifacts in this project's history read as complete while silently truncating: a regex that found 1 of 3 dirty columns, a harness that covered 1 of 93 free-text columns, an audit that verified 24 of 31 findings behind its own `slice(0, 24)`.

A sub-agent summary is that same failure with a friendlier interface. Every sub-agent returns this shape and only this shape:

```
FINDING <id>
Claim:      <one sentence, no hedging>
Evidence:   <file:line>, plus the relevant lines quoted verbatim
Confidence: MEASURED | ESTIMATE

DENOMINATOR
Read <N> of <M> <units>. Not read: <explicit list, or "none">.

NOT DETERMINED
<explicit list of questions in the brief that the evidence did not answer, or "none">
```

`MEASURED` requires a `file:line`, a git sha, or a query result. Anything else is `ESTIMATE`. **Never promote an estimate to a measurement.**

## 2.3 A sub-agent may return "not determined"

A sub-agent that believes it must produce an answer will produce one. Say so explicitly in every brief: **an honest NOT DETERMINED is a successful return.** An inferred answer to O-1 is worse than no answer, because a half-built corrections-only path that silently reverts renames is worse than the current cost.

## 2.4 Sub-agents do not talk to each other

Fan out, fan in. No sub-agent reads another's output. The parent is the only place findings meet. This keeps each denominator attributable to one reader.

## 2.5 Each brief names its own reading list

A sub-agent starts with a fresh context and inherits nothing from the parent session. Each brief must name the files it reads, including which sections of the master context, because the operator is credit-limited and seven agents each reading a 650-line document is a cost with no return.

**Every brief includes Part IV of the master context**, sections 14 and 15. An agent reading the miner without invariant 14.5 in context will not notice that a proposed telemetry attr carries a label.

## 2.6 Sub-agents must not

Run the miner, under any circumstance. Push anything. Modify the security harness. Change a resolution threshold, page size, prompt or model config, even experimentally. Answer O-1 by inference. Propose a fix; the brief asks what is true, not what to do.

---

# 3. Phase 0 investigation roster **[Locked]**

Seven briefs, dispatched in one parallel wave. Each corresponds to one question with a discrete evidentiary answer. **The roster is not a division of the codebase into territories; it is a division of the open questions.**

Common preamble for all seven:

> You are a read-only investigator on the Memo codebase. Read `docs/memo-master-context.md` Part I sections 1 to 4 and Part IV sections 14 to 16 in full, plus the sections named in your brief. Write nothing. Run no command with a side effect. Never run the miner. Return only the FINDING / DENOMINATOR / NOT DETERMINED structure. An honest NOT DETERMINED is a successful return; an inferred answer is a failure.

---

### I-1. The O-1 blocking question **[P0]**

**The single highest-value brief in the roster. Phase 2 does not exist without its answer.**

Question: can the rename force-write and the `resolveSurvivorIds` ordering be satisfied outside a derivation run?

Context sections: 22, 23, 25, and Part VIII Stage B.
Reads: `derive.ts` (particularly 201-206, 541, 605-612), `stage-common.ts:386-388`, `applyRenameLabels`, `supersedeLosers`, `retireStaleRelationships`, `repointReferences`, `resolveSurvivorIds`, `changeSignature`, `writeCanonical`, `app/people/actions.ts`. Git history including `328ebeb`.

Required return: **the four questions in work order section 0.1, each answered separately for `rename_person` and for `merge_people`.** Do not answer them jointly. The work order permits one kind to take the corrections-only path while the other still forces a full.

Also return: exactly what state the people pass produces that the relabel reads, with `file:line` for each read.

---

### I-2. Mode branch and miner state **[P0]**

Question: where is the full-versus-incremental decision made, what advances the corrections fingerprint, and what would a `corrections_only` mode have to write and skip?

Context sections: 17, 22, 24, 25.
Reads: `miner_state` schema and every reader and writer of it, the incorporated markers, the corrections fingerprint computation, the per-pass input hash, the mode branch itself, `miner_runs` schema and its status and mode columns, the partial unique index on `status='running'`.

Required return: the transaction boundary available at the fingerprint advance, and whether the fingerprint and the graph operation can be made atomic in one transaction. **Constraint 2.2 of the work order is atomicity; this brief establishes whether it is mechanically available.**

Also: whether adding a `corrections_only` mode value requires a migration, with the column definition quoted.

---

### I-3. Resolver instrumentation surface **[P0]**

Question: what does adding a tier discriminator to `Resolver.resolve` touch?

Context sections: 19, 20, 27, and Stage A-2.
Reads: `Resolver.resolve` and every call site with a count, `buildResolver`, `readAliasMap`, `runNodePass`, `record()` at `derive.ts:541`, the `telemetry_events.attrs` schema, and the harness assertion that guards attr contents.

Required return: the call-site denominator (N of M), the current shape of the `miner_run` telemetry attrs quoted verbatim, and **which harness assertion a new attr name would touch.** Section 14.5 makes attrs a shaped column; the five tier counts are enums and integers and should pass, but the brief confirms rather than assumes.

---

### I-4. Retirement signal surface **[P0]**

Question: what does distinguishing "nothing qualified" from "the cap refused" touch?

Context sections: 23, 26, and Stage A-1.
Reads: `retireAbsorbedRows` including both returns at `stage-common.ts:545` and `:554`, the pass result type, `shapedSummary`, the `miner_runs.summary` write path, and the Memory screen's read of run mode and retirement.

Required return: the exact current summary shape as persisted, and whether the Memory screen currently reads run mode at all or would need a new read. **Do not propose raising the cap.** Report the cap expression and leave it.

---

### I-5. Capture write path census **[P1]**

Question: how many capture write paths exist and how many go through `writeCapture`?

Context section: 28, and Stage D.
Reads: every `.from('captures')` site, `lib/captures.ts` (the cap at `:38` enforced at `:57`, the dedup window at `:44` enforced at `:66`), and `app/api/interview/end/route.ts:83`.

Required return: **X of Y, stated as a number, with every site listed by `file:line` and classified.** The master context asserts 12 sites, 2 inserts, 6 write paths, 5 guarded. Confirm or correct each figure independently.

Also: the longest interview transcript in live data, in characters, so the operator can judge whether 100,000 is a real ceiling before Phase 3 changes anything.

---

### I-6. Invariant and harness impact **[P0]**

Question: what does `npm run security` assert today, and what would move it?

Context: Part IV in full, plus Part XIV, the incident log.
Reads: all harness surfaces with a count, `check-table-isolation.mjs`, `check-avatar-isolation.mjs`, `check-invite.mjs`, and the free-text column assertions.

Required return: the surface count and what each surface asserts, one line each. Then, for each of the three changes Phases 1 and 2 propose, which invariants from 14.1 to 14.7 and 15.1 to 15.7 are in play.

**Report only. Do not fix anything.** The three guards that hard-delete auth users are WO-6 items 3 and 4 and are out of scope for this work order.

---

### I-7. Baseline measurement **[P0]**

Question: what is the before picture that Phase 2's acceptance is measured against?

Context sections: 11, 20, 25, 27.
Reads: read-only queries only.

Required return, each with its denominator:
- Pending corrections: count, kinds, and the stored versus recomputed fingerprint.
- Live row counts per canonical table, against the audit's 529 total.
- `miner_runs` for the last 45 days: mode, outcome, duration, calls, cost.
- What the Memory screen renders today for run mode and for retirement.

**This brief runs no mine and dispatches no Action.** If a figure is only obtainable by running the miner, return it as NOT DETERMINED.

---

# 4. Synthesis rules for the parent **[Locked]**

**4.1 Carry the evidence table through; do not compress it.** The plan document quotes the `file:line` citations. A plan that says "the investigation confirmed the relabel is independent" without the citation has recreated the summarization failure one level up.

**4.2 Report every NOT DETERMINED in the plan document,** gathered into one list. This is the plan's own denominator and section 0.3 of the work order requires it as the assumptions list.

**4.3 A sub-agent finding that contradicts a MEASURED number in the master context is a stop condition.** Report the contradiction with both figures and both sources. Do not quietly build on the newer number and do not average them.

**4.4 Two sub-agents disagreeing is a finding, not noise.** Report both with their evidence. Do not pick.

**4.5 Where I-1 answers no for one correction kind, say so plainly and let that kind force a full.** Work order constraint 2.2 is explicit: do not force a full defensively for both because one is uncertain.

**4.6 If I-1 answers no for both kinds, stop.** Report why with evidence and propose no partial version. That is the work order's first stop condition and it ends the session.

---

# 5. Phases 1 to 3

Governed entirely by the work order. This document adds only two things.

**5.1 Sub-agents in implementation phases are for verification, not for writing.** A sub-agent may be dispatched to confirm a call-site denominator or to re-read a file the parent has changed. It does not write the change. Rule 2.1 holds through every phase.

**5.2 State the branch before every push.** `git branch --show-current`, stated in the session output. Rule 15.2 exists because an agent pushed a destructive migration to main one hour after writing the rule it violated.

---

# 6. What this session does not produce

**No product prompts.** The work order freezes the miner prompts explicitly in section 2.3. No prompt, model config, effort setting, page size or threshold appears in any diff from this session. The interview generation prompts belong to WO-3 and are a separate session with a separate doctrine.

**No sequencing analysis.** The work-order-set meta-task at `docs/plans/work-order-sequencing.md` is a different session. It is better run after WO-1 merges, because the resolver histogram from Stage A-2 is a real input to judging WO-2 and does not exist yet.

**No Stage C, E, F, G or H work.** Stage H in particular: at 529 rows an in-memory scan is adequate. It is deferred with a stated trigger condition. Do not build it because it looks like the obvious next optimisation.

**No fixes found along the way.** A sub-agent that finds a bug outside WO-1's scope reports it as a FINDING. The parent lists it in the plan document under a "found, not fixed" heading. It does not get fixed in this session.

---

# 7. Session summary

| Stage | Mode | Output | Then |
|---|---|---|---|
| Phase 0 | Plan mode, 7 sub-agents, one wave | `docs/plans/miner-cost-fix-plan.md`, one PR | Stop. Operator responds. |
| Phase 1 | Plan mode, then one PR | Stage A, legibility | Stop. Operator merges and mines. |
| Phase 2 | Plan mode, then one PR | Stage B, corrections | Stop. Operator runs the five-step live check. |
| Phase 3 | Plan mode, then one PR | Stage D, capture guard | Stop. |

**One PR per phase. The session stops after each. Never chain phases.**
