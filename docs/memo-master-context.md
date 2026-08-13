# Memo: Master Context Document

Version 2, 2026-08-11. Supersedes `memo-context.md` v1 and `miner-rearchitecture-spec.md` (the latter was written on inference and refuted by measurement; do not restore it).

**Purpose.** This is the single document handed to a new session working on Memo. It replaces reading ten files. It states the thesis, what exists, what has been measured, what has been decided, what has been refuted, and what remains open.

**Sources.** `docs/miner-architecture-audit.md` (PR #52, 718 lines, open, unmerged), the miner runs `31225406094` and `31229780169` of 2026-08-07, the ideation session of 2026-08-08, `memo-spec-v1.md`, `CLAUDE.md`, `docs/HANDOFF.md`, and the incident record of 2026-08-07.

---

## How to read this

**Doneness tags.** **[Locked]** means implement as written; it is a constraint, not a suggestion. **[Open-Blocking]** must be resolved with the operator before any code depends on it; ask, do not assume. **[Open-Exploratory]** wants two to four options surfaced for a human to choose; do not pick. **[Parked]** was considered and deliberately set aside; the reason is recorded so it is not rediscovered. Untagged means Open-Blocking.

**Evidence tags.** MEASURED means a query result, a `file:line` citation, or a log line exists. ESTIMATE means it does not. **Never promote an estimate to a measurement.** Several bad decisions in this project's history came from an inference being restated confidently enough that it started reading as a fact.

**The denominator rule applies to this document too.** Where it does not know, it says so. Part XVI lists what it does not cover.

---

# PART I: WORKING RELATIONSHIP

## 1. Roles

The operator is Todd (also Nate Tennant / NateKeola). He is non-technical about code and credit-limited on the coding agent. He does not write application code. The chat model acts as technical architect, prompt author, and strategic advisor; its deliverables are self-contained prompts written as markdown files. A coding agent branches, builds, and opens a PR. **A human always merges. Agents never merge.**

The loop: spec in chat, write a prompt as a file, the operator runs it, he reports back, the chat model interprets and cuts the next prompt.

## 2. Standing preferences **[Locked]**

No em dashes anywhere in prose, code, comments, or PR bodies. Direct and terse. Take positions with reasoning rather than offering option menus. Minimal preamble. End each reply with one clear action paragraph. Prune aggressively. No slop.

He is frustrated by guessing and by operator-config friction. He wants the app shipped to real beta users.

## 3. What the agent cannot verify **[Locked]**

The agent cannot run the miner (it runs off-machine on a GitHub Action), cannot drive a real microphone or browser, and cannot run an iOS simulator. **The operator's live run is the only proof for anything involving the miner, voice, the browser, or a device.** Never claim those are verified from the agent side.

## 4. What the agent must not be given **[Locked]**

No Supabase management token, no service-role key pasted into a chat, no GitHub PAT with admin scope. The permission boundary that blocks an agent from configuring branch protection is the same one that keeps prod infra credentials out of a session. That boundary is correct and is not to be worked around.

---

# PART II: THE THESIS

## 5. What Memo is

A personal companion that remembers your life, built on one primitive: **an interview agent that asks the questions worth asking, and a deterministic miner that turns the answers into a queryable knowledge graph.**

The foundational insight: people struggle to consciously journal or self-report, but can easily answer questions. So the agent extracts by asking rather than requiring deliberate effort.

The LLM is one stage of a deterministic pipeline, not the orchestrator. Design language is "warm notebook": browns and creams, Newsreader serif, a dandelion mark over a neuron-field background.

## 6. Put yourself anywhere

The positioning line from the 2026-08-08 session, kept verbatim.

The insight: autonomous agents produce continuously, and the scarce resource is not their output but the human judgment they occasionally need. The product is a **clip you attach to an agent loop.** The clip is a gate. The gate holds criteria that determine when the agent must stop and interact with its host.

Two things make this a product rather than a feature:

**The criteria are the moat**, not the gate mechanism. The sellable, collaborative, opinionated work is helping a customer define what constitutes a decision point worth interrupting a human for.

**It is model and stack agnostic.** A clip attaches to any agent loop, so it sits above the agent frameworks rather than competing with them.

The convergence that matters: this is already Memo. Memo asks you questions. The coding-agent gate is one application of the interview agent, not a separate product.

Note the structural echo with Miine, where the relationship is the moat and the pipeline is not. Both products converge on the claim that **the defensible thing is the elicitation, not the extraction.**

## 7. The loop, in miniature

Upload a transcript. Memo generates an interview from it: "How would you grow Trident if you restarted it right now?" You take the interview. The answers become structured context in the graph, which feeds the next interview.

**The system procures its own interviews from your raw material.** That is the whole thesis, and it is testable in one week. See F-1.

## 8. Roadmap position

Miine v1 shipped. Memo and Memo Enterprise are v2. v3 unspecified. Explicit commitment to iterate fast on v2 rather than perfect it.

## 9. The unresolved tension **[Locked as unresolved]**

Nate's position: build it for ourselves, use our own workflow as the design spec, trust that others operate similarly. The payoff is double, the product plus the productivity gain.

Todd's counter: the niche risk, over-fitting to ourselves. The heuristic is "if you were restarting Trident right now, what would you do differently", which is about extracting transferable learnings rather than re-solving idiosyncratic problems.

**This is not resolved and should not be.** It is the productive version of the dogfooding argument. Recorded so a future session does not resolve it by accident.

---

# PART III: WHAT EXISTS

## 10. Stack

Repo `github.com/NateKeola/memo-phoenix`. Next.js App Router, TypeScript, npm. Supabase for Postgres, RLS, Auth and Storage, one production project (`azlobwtiptvarfeukzcv`). Migrations apply to prod through a GitHub Action on merge. Vercel pinned to `sfo1` to co-locate with the Supabase `us-west-2` project. ElevenLabs for Conversational AI interviews and Scribe for STT. Miner model `claude-opus-4-8`, `MINER_EFFORT=high`, adaptive thinking on, `MINER_MAX_TOKENS` 40000, verbose page size 15 and 40 otherwise, streaming via `messages.stream`.

Operator config set: custom SMTP through Resend, `MEMO_ADMIN_EMAIL`, `GITHUB_DISPATCH_TOKEN`, `GITHUB_REPO`, and the migrate secrets.

## 11. Users, MEASURED

`auth.users` holds 14 rows: 4 real (natekeola 40 captures, toddrdgavin 2, mpetersen1 2, nprestine 0), 8 `inc-harness-*@test.invalid` holding 76 captures between them, and 2 permanent guard accounts (`memo-guard-a`, `memo-guard-b`).

**Note:** mpetersen1 was not in the original beta list and holds live captures. The operator was asked to confirm the account and has not. If it was not invited, the allowlist has a gap. Not blocking; recorded.

Harness accounts hold 76 of 120 captures, 63 percent of the corpus. This is tech debt, deliberately not acted on, because deleting an `auth.users` row is what produced the 578-orphan incident.

## 12. Shipped and merged

Warm-notebook redesign. Email and password auth with allowlist, public signups disabled, no email on signup or login. Self-service password recovery. Streaming miner (PR #30). Incremental mining. Stable identity with `entity_aliases` and a resolution ladder. A large audit-and-fix pass covering dedup, row retirement, zombie-run reclaim and capture dedup (2026-07-01, 2026-07-02). Admin-only observability at `/admin/observability`. Profile screen with photo upload on private Storage with per-user RLS and signed URLs. Certified security harness, `npm run security`, 8 surfaces. Latency pass with streaming skeletons and the region pin. Capture from every screen via a shared `AppChrome` plus entity-scoped capture tagging. Contact create and import through the capture pipeline. Miner token fix and run-mode recording (PR #46). Orphan archive and purge, harness guard fix (PR #47, migration 0021). Miner call instrumentation and content redaction (PR #48, migration 0022). Push-to-main guard (PR #49). Short claim handles (PR #51).

## 13. Open right now

**PR #52**, branch `miner-architecture-audit`, one file, 718 lines, the audit this document is largely built on. **Not merged.** It deviated from the standing rule that every PR updates `docs/HANDOFF.md` and appends a `CLAUDE.md` decision entry, and it stated the deviation rather than hiding it, because the PR was scoped to contain only the audit document. **Fold its findings into both in a follow-up.**

**Issue #50**, the 2026-08-07 incident record. Needs the Destructive Migration label attached, which only the owner can do.

---

# PART IV: INVARIANTS AND STANDING RULES

All **[Locked]**. Violating one is a stop-and-report, not a judgment call. Most were written after an incident; the incident is named where it exists.

## 14. Data invariants

**14.1 The miner is the only writer of the canonical graph.** The app never writes canonical directly. Every feature that adds or edits knowledge (renames, merges, splits, disputes, added context, contact creation, entity tags) routes through captures or append-only corrections and overlays, or the next mine erases it.

**14.2 Provenance is mandatory.** Every raw row carries a `capture_id`. Every canonical row carries `source_claim_ids`.

**14.3 RLS scoped to `user_id` on every table, enabled and forced.** Service-role key is server-side only. Soft delete only.

**14.4 Never hard-delete a row from `auth.users`.** Deleting a user strands rows in `canonical_history` that no RLS policy can ever reach, because the predicate is `user_id = auth.uid()` and no such user can authenticate. This applies to test teardown and to the documented recovery pattern of clearing a stuck user's auth row so they can sign up fresh. Retire an account by disabling it. *Origin: 578 orphan rows across 97 vanished users, accumulated over roughly fifty security-harness runs, discovered by the Phase 1 pre-flight gate.*

**14.5 Anything persisted to a database column is shaped. Anything written to stdout may be full.** Error messages, error contexts and exception text bound for any table carry ids, indices, counts, enums, positions and durations only. Model output, entity labels, and third-party parser messages that may embed input are stdout only. Covers `miner_runs.error`, `miner_runs.summary`, `observability_events.error_message`, `telemetry_events.attrs`, and any column added later. *Origin: three columns found carrying model prose about the operator's family, career and relationships.*

**14.6 The four data categories.** IDENTITY is user-keyed and cross-scope readable (`auth.users`, `user_profiles`, avatar objects). KNOWLEDGE is scope-keyed and scope-authorized (captures, raw, canonical, corrections, `entity_aliases`, `miner_runs`). TELEMETRY is admin-authorized and scope-labelled for filtering only (`observability_events`, and `usage_ledger` when it lands). ARCHIVE is service-role only, lives in the `audit_backup` schema, gets no RLS policy, no `scope_id`, and no PostgREST exposure, and is excluded from every guard that enumerates public tables.

**14.7 `observability_events` never receives a `*_scope_v2` policy.** Its authorization is admin-only permanently. Phase 2's "drop the v1 policies" step must skip it; dropping its v1 policy would leave it with no policy at all.

## 15. Process invariants

**15.1 Branch off main, PR, human merges.** Enforced by a pre-push hook (`.githooks/pre-push`, activated by a `prepare` npm script) and by GitHub branch protection with the admin bypass closed. Both were tested: the hook refuses, and with bypass closed the server refuses `--no-verify`.

**15.2 Before any push, confirm the branch.** Run `git branch --show-current` and state it. If it is main, stop and branch. *Origin: an agent pushed a destructive migration to main by accident on 2026-08-07, one hour after writing the rule it violated.*

**15.3 Every PR updates `docs/HANDOFF.md` and appends a dated `CLAUDE.md` decision entry** in the same diff. PR #52 is a stated exception, not a precedent.

**15.4 Additive migrations only.** Destructive migrations, defined as anything that disables an append-only trigger or deletes rows, require the human Destructive Migration label before merge.

**15.5 Migrations reach production only through the GitHub Action on merge.** Never `db:apply` from a laptop, never before review.

**15.6 Any check that enumerates must report its denominator and assert it covered everything.** A regex found 1 of 3 dirty columns. The harness covered 1 of 93 free-text columns. An audit verified 24 of 31 findings behind its own `slice(0, 24)`. Each read as complete while silently truncating. **A check that cannot state what it did not look at is not a check.** This applies to the agent's own process, not only to code.

**15.7 If the harness fails, clean the data.** Never relax the guard, exempt a column, widen a predicate, or change the assertion.

## 16. Recorded design findings

Kept so they are not re-proposed.

**16.1 Consumption tracking is not a sound lever for reducing the miner payload.** Claim consumption is not exclusive: 4 of 8 canonical tables show a single claim cited by more than one node in the same pass. Counterexample: claim `6b4fad05` cited by both "La Quinta" and "BillionToOne". The prompt already instructs one claim per node and the model violates it, so the invariant is not enforceable by instruction. Denominator: 8 of 8 tables checked.

**16.2 Node-level ACL is dead permanently.** A canonical node derives from `source_claim_ids` belonging to several users with different visibility, so any node-level ACL resolves to either the intersection (which makes shared nodes invisible to everyone) or the union (which is a leak).

**16.3 Miine's miner links claims to nodes by the raw row's primary key uuid and asks the model to reproduce it verbatim.** It has no handle indirection. It has not hit Memo's transcription failure because it is single-shot with no repeated payload, not because its design is safer. Do not assume Miine has solved a problem Memo has.

**16.4 The lenient translator fields are deliberate.** `discrepancies[].claim_ids` and `open_threads[].source_claim_id` drop unmapped handles rather than throwing, to reproduce today's tolerant behaviour. Tightening them is a separate decision with its own PR.

---

# PART V: THE MINER, AS MEASURED

Everything in this part is MEASURED from the 2026-08-08 audit against runs 8 and 9.

## 17. Pipeline topology

Fourteen stages. Transcription (voice only, app), capture write (app), run claim and lock, user-id assertion, capture read with exclusions, extraction (one model call per capture), extraction memoization, mode decision, derivation passes, loser supersession, rename force-write, absorbed-row retirement, freshness reconciliation, run bookkeeping.

**Eight derivation passes in order:** `canonical_people`, `canonical_places_orgs`, then supersession and rename force-write, then `canonical_projects`, `canonical_events`, `canonical_facts`, `canonical_relationships`, `canonical_commitments`, `insights`.

**Three ways to start a mine, and no others.** The app route runs inline only when the corpus is at or under `MINER_INLINE_MAX_CAPTURES`, otherwise it dispatches to the Action; the Vercel function has `maxDuration = 300`. The GitHub Action runs `npm run miner` with no `timeout-minutes`, so the default 360 minutes applies. The local CLI uses the same code path. A partial unique index on `miner_runs` where `status='running'` makes a collision return `already_running` rather than a second concurrent mine.

## 18. Data model

23 distinct tables of 35 public base tables. Eight append-only raw claim tables plus `captures`, `corrections` and `confirmations`. Eight canonical tables mutable by the miner only. Four state tables (`miner_state`, `miner_runs`, `entity_aliases`, `capture_exclusions`). Two telemetry tables. One history table.

**Trigger census, read live:** 13 `forbid_mutation` triggers all enabled, 10 `snapshot_canonical` triggers.

`confirmations` has no writer and no reader anywhere in the codebase. Its intended role was never investigated.

**Identity scheme, two mechanisms coexisting.** `canonicalId` is a UUIDv5 over `(userId, table, normalizeLabel(label))`, content-derived and stable for a stable label. `canonicalPersonId` hashes first plus last name. `canonical_relationships` never uses the resolver: its id is `canonicalId(userId, table, "source|target|relation")`, fully determined by endpoints and verb. When the resolver misses every tier it mints `randomUUID()`, which is not content-derived.

## 19. The resolver

`STABLE_IDENTITY` defaults on. `buildResolver` reads the live current rows of the target table, unbounded. `readAliasMap` loads `entity_aliases`, 686 live rows for the real user.

**Ladder order:** exact normalized label, then persisted or in-run alias, then conservative token-Jaccard fuzzy at `MINER_RESOLVE_FUZZY` default 0.8 with an ambiguity margin guard, then mint a random uuid. Commitments additionally pass a context key of `data.person_id`; context agreement relaxes the fuzzy bar to 0.5 and **context disagreement is a hard block that overrides even an exact text match.**

7 of 8 passes build a resolver. Relationships build none by design, because edge ids derive from already-resolved endpoints.

**The model is already out of the identity path.** It proposes labels; code decides ids.

**Tier distribution is NOT DETERMINED.** Nothing records which tier resolved a claim; none of the 21 live `telemetry_events` types is resolver-related. The audit names this the single highest-value missing measurement in the system.

**The one measurable proxy is the mint rate,** because a mint is v4 and a derived id is v5.

## 20. Minted-id share by table

| Table | v5 derived | v4 minted | total | minted |
|---|---|---|---|---|
| canonical_commitments | 5 | 34 | 39 | 87.2% |
| canonical_facts | 44 | 66 | 110 | 60.0% |
| canonical_events | 25 | 27 | 52 | 51.9% |
| insights | 47 | 26 | 73 | 35.6% |
| canonical_places_orgs | 62 | 23 | 85 | 27.1% |
| canonical_people | 56 | 12 | 68 | 17.6% |
| canonical_projects | 25 | 2 | 27 | 7.4% |
| canonical_relationships | 75 | 0 | 75 | 0% |
| **total** | **339** | **190** | **529** | **35.9%** |

**The pattern:** the fuzzy tier is tuned for names and fails on sentences. Commitments and facts are phrase-shaped. Commitments are worst because the context-key hard block discards exact matches whenever a linked person id moves.

## 21. Payload composition

**The incremental path sends the entire canonical layer for the type.** `readCanonicalNodes` applies no LIMIT, no ranking and no filter beyond user scope and currency. All six incremental node passes call it unbounded.

**The full path sends less context than the incremental path.** Three of six full node passes send `context: []` (people, places_orgs, facts); the other three send people-plus-places only. **No full pass is ever shown its own table's existing rows.** That asymmetry is documented nowhere in the repo.

| Pass | Full ctx nodes | Full tokens | Full ctx share | Incr ctx nodes | Incr tokens | Incr ctx share |
|---|---|---|---|---|---|---|
| people | 0 | 13,052 | 0% | 68 | 3,219 | 92% |
| places_orgs | 0 | 8,106 | 0% | 85 | 4,221 | 95% |
| projects | 153 | 11,463 | 75% | 180 | 11,116 | 96% |
| events | 153 | 14,044 | 60% | 205 | 11,703 | 98% |
| facts | 0 | 7,313 | 0% | 110 | 6,717 | 96% |
| commitments | 153 | 12,297 | 70% | 192 | 11,473 | 98% |
| relationships | 342 | 26,401 | 78% | 342 | 26,401 | 78% |
| insights | 417 | 51,780 | 100% | no incremental pass | | |

**Folding a single new capture costs roughly 74,850 input tokens across 7 passes, 92 to 98 percent of it existing context re-sent from scratch.** The claims themselves are 400 to 700 characters.

Payload reconstruction validated exactly against telemetry for the three empty-context passes: people 31,001 chars against 31,001 recorded, places_orgs 18,739 against 18,739, facts 14,688 against 14,688.

## 22. Incremental mechanics

Three state mechanisms in `miner_state`: **incorporated markers** per capture, written only after `runDerivation` returns; the **corrections fingerprint**, a sha256 over the ordered corrections; and a **per-pass input hash** covering claims, context key, corrections fingerprint and identity mode, where a hit skips the pass entirely.

The branch: full if no baseline exists or if the corrections fingerprint changed, otherwise incremental, otherwise no-op when nothing is unincorporated.

**At the pass level, incremental and full are structurally the same code.** Two differences only: the claim set (all claims versus new-capture claims), and the write step (incremental merges `source_claim_ids` by union and never calls `retireAbsorbedRows`).

**There is no incremental insights pass.**

## 23. Write semantics and retirement

`changeSignature` contains only `source_claim_ids` and `temporality`. **The label is deliberately excluded**, to stop cosmetic rewording from rewriting every row. This single fact is why `applyRenameLabels` must exist.

The absorbed-row test: a live row not re-emitted, with claims, all of which were attributed to rows the pass did emit or are excluded.

The safety cap: `Math.max(5, Math.floor(current.length * 0.5))`. If candidates exceed it, the retirement is skipped entirely with a `console.warn`.

**A live row that no pass re-emits and that fails the absorbed test stays live forever.** No age-out, no confidence floor that removes rows; read-time decay changes only reported confidence.

**The defect:** the function returns `{retired: 0}` both when nothing qualified and when the cap refused. `miner_runs.summary` records the same value in both cases. The only distinguishing evidence is stdout in the Actions log:

```
run 8  retirement SKIPPED for canonical_projects: 18 qualified (> cap 14 of 28)
run 8  retirement SKIPPED for canonical_facts:    57 qualified (> cap 55 of 110)
run 9  retirement SKIPPED for canonical_projects: 17 qualified (> cap 13 of 27)
```

**`canonical_facts` exceeded its cap by two rows.** Those 57 rows had passed the absorbed test, meaning every claim each cites was re-attributed elsewhere. They remain live. This is the mechanical cause of the largest divergence between live and emitted counts: facts 110 live against 53 emitted, projects 27 against 10.

## 24. Determinism

**The graph is not reproducible. 35.9 percent of live rows carry an id that exists only because of the order past runs happened.**

Consequences: anything keyed on a canonical id from outside the miner, including `companion_state.commitment_id`, `superseded_by`, and `insights.affected_entity_ids`, is keyed on a path-dependent value for that 35.9 percent. `canonical_relationships` is 0 percent minted but its content-derivation is second order, since the endpoint ids it hashes are themselves 35.9 percent path-dependent.

Two further sources not quantified: model output varies run to run, and batch composition within a pass depends on what the model emitted first.

**An incremental-first design would surrender a nominal property, not a real one.**

## 25. Corrections

**Two kinds exist, from 2 of 2 insert sites in the entire application**, both in `app/people/actions.ts`: `rename_person` and `merge_people`. Nineteen rows live.

| Kind | Blast radius | Model calls today | In principle |
|---|---|---|---|
| rename_person | 1 person row relabeled plus aliases | a full recompute, 20 calls | 0 |
| merge_people | 1 row retired, N edges retired, M references repointed | same | 0 |

**Why `applyRenameLabels` runs after the people pass.** It is a force-write that must beat `changeSignature`. The people pass does compute the corrected label, but when a renamed person's claim set has not changed, `writeCanonical` classifies the row `unchanged` and never issues the update, so the computed label is discarded and the old label survives. It runs after because `resolveSurvivorIds` must read rows the people pass just wrote, and before `aNodes` is read so stages B and C see the corrected label. Git history confirms it is a bug fix, not a design: `328ebeb fix(corrections): renames now land and clear pending on the next mine`.

**`split_person` is unbuilt and is not a label operation.** It requires a claim-level partition payload, a derivation branch that overrides the model's grouping (the model will regroup identically otherwise), ids for at least the new side, and downstream repointing where `repointReferences` is a one-to-one map that cannot express a one-to-two decision. Live cases needing it: `Nate (friend)` absorbed into `Nate Tennant`, and `Brian Tennant` carrying a work colleague's claims.

## 26. Synthesis outputs

| Output | Computed from | Persisted |
|---|---|---|
| Insights | The whole canonical layer, 417 nodes, 109,805 chars | Yes, 73 live rows |
| Discrepancies | Per-pass model side output, parsed and deduplicated | **No** |
| Open threads | Per-pass model side output, only counted | **No** |

Discrepancies are consumed in-run by `supersedeFromDiscrepancies` and then discarded. Open threads are never parsed into objects at all.

**The discard point moved in migration 0022.** Items previously survived on `miner_runs.summary`; `shapedSummary` now strips them at persist time because they carried model prose about real people.

**`discrepancies` and `open_threads` exist since migration 0006, hold 0 rows, and have no reader.** `collections` and `collection_items` are also empty.

## 27. Cost and time, MEASURED

| | calls | input | output | cache read | cache write | model time | cost |
|---|---|---|---|---|---|---|---|
| run 8 | 20 | 286,341 | 189,390 | 10,184 | 7,902 | 36.9 min | **$6.22** |
| run 9 | 12 | 217,259 | 146,031 | 6,693 | 6,871 | 29.6 min | **$4.78** |
| both | 32 | 503,600 | 335,421 | 16,877 | 14,773 | | **$11.00** |

Run 8 wall clock 38m 48s, run 9 wall clock 31m 11s. Run 8 was 96 percent model time. Run 9 made fewer calls because `places_orgs` and `facts` hit the input-hash memo and were skipped entirely.

**Cost attribution for run 8:** output tokens $4.735, **76.1 percent of the run**. Input $1.432, of which canonical context is $0.650, **10.4 percent of the run**. Cached system prompt $0.054, **0.9 percent**.

**Removing all canonical context from every payload on a full recompute saves about 65 cents on a $6.22 run.**

**Prompt caching is working and nearly irrelevant.** Net saving $0.058 across both runs, 0.5 percent. The cached system block is 1,031 to 1,429 tokens against Opus 4.8's 1,024-token minimum; the `places_orgs` block clears it by **7 tokens**, so a small prompt edit would silently stop it caching.

**Reliability after PR #51:** all 32 calls returned `stop_reason: end_turn`, zero non-ok outcomes, zero retries, zero rejected claim ids. **The claim-handle scheme works completely.**

## 28. The interview capture bypass **[Locked] [P1]**

`captures` has 12 `.from('captures')` sites, of which 2 are inserts. **Only one goes through `writeCapture`.** `app/api/interview/end/route.ts:83` inserts directly.

`writeCapture` applies two guards this path does not get: the size cap `MAX_CAPTURE_CHARS` (100,000, `lib/captures.ts:38`, enforced at `:57`) and the content-dedup window `DEDUP_WINDOW_MS` (10 minutes, `:44`, enforced at `:66`).

**Interview transcripts are the longest capture type in the system and are the only capture type with neither a length cap nor a double-submit guard.**

**This has already cost a data repair.** Two of the four duplicate captures the 2026-07-02 repair had to retract were exactly this failure mode. It is not theoretical.

Capture-path denominator: 6 paths, 5 through `writeCapture`, 1 direct.

---

# PART VI: THE MIINE REFERENCE MINER

Read from `reference/context-miner-updated-reference`. 5,726 lines across 13 files, against Memo's 21.

**Topology.** Runs are consumed from a queue rather than triggered. Stages A (people, entities), B (processes, responsibilities), C (relationships, insights), Knowledge, Summaries. Tenancy key is `company_id`. Rounds are first-class: rows carry `first_seen_round` and `last_updated_round`.

**Identity: no content derivation at all.** Every id is `randomUUID()`. Continuity comes entirely from matching forward.

**Resolution is a deterministic code ladder, model excluded.** Tier 1 exact primary identity, one-to-one. Tier 2 alias overlap. **Tier 3, the claim-overlap fallback**, restricted to five churn-prone tables, matching on provenance rather than text: intersection over the smaller claim set, threshold above 0.5, ties broken on most recent round, remaining ties left unmatched. The comment states the posture: "an insert+retire is safer than a wrong merge." Tier 4 mint.

**The prompts forbid the model from emitting ids.** Canonical nodes are given "ONLY to name holders and topics" and are referenced by name, "these are node ids, NOT provenance." Memo does the opposite: its model emits canonical uuids into `related_ids` and edge endpoints.

**No incremental path.** PR5 deleted the batch loop; `has_more: true` is now treated as a truncation alarm rather than a pagination signal. No memoization, no incorporated markers, no "new since last run" concept.

**Retirement is unconditional.** Every existing row not matched is stamped and deleted, archived by trigger. No absorbed test, no cap. Marked LOCKED against a spec section.

**No corrections mechanism at all.**

## 29. Mechanism count

Memo has and Miine lacks: content-derived ids, an incremental path with markers and memoization, a persisted alias table, corrections with downstream repointing, output pagination, a freshness loop with decay and salience, a retirement safety cap, short claim handles. **Eight.**

Miine has and Memo lacks: a claim-overlap identity fallback on provenance, unconditional retirement, one-to-one assignment with explicit ambiguity abstention, a by-name-only prompt contract, `has_more` as a truncation alarm. **Five.**

## 30. Should `miner-core` stay shared? **[Locked: no]**

**They should diverge permanently, and the evidence is that they already have.** The overlap is a design pattern, already written down in `context-mining-pattern.md`, and a pattern is not a package.

The workload difference explains it and predicts more divergence. Miine mines a bounded corpus that grows in discrete rounds and then stops, for a company that can tolerate a full recompute per round. **Unconditional retirement is safe there:** if a row is not in the current worldview, the current worldview is right, and the round boundary is a natural consistency point. Memo mines a life, which has no ceiling and no rounds, where a fact from June must survive a run in December that never mentions it. That is a difference about **whether absence of evidence is evidence of absence**, and it cannot be parameterised away.

Keep the pattern document shared, let the code diverge, treat cross-pollination as deliberate porting. **The one mechanism worth porting now is the claim-overlap fallback**, scoped as Miine scopes it, because Memo's `canonical_facts` has precisely the churn problem it was built for and Memo's answer is a cap that refuses.

---

# PART VII: WHAT THE AUDIT REFUTED

Recorded so nobody rebuilds these arguments. Each was asserted confidently in the superseded re-architecture spec.

**Context reduction is not the win for full recomputes.** Output is 76.1 percent. Context is 10.4 percent.

**A three-tier ladder with the model as last resort already ships.** A new ladder of the same shape would inherit the same miss rate. If the resolver produces 190 mints from 529 rows, the failure is that its fuzzy tier is too tight for phrase-shaped labels, not that the model is involved.

**Determinism is not being surrendered. It was never held.**

**Local filing is available for 3 of 8 types unconditionally,** 6 of 8 given a resolved person layer. Relationships are global by construction. Insights take no claims.

**Background pairwise reconciliation would move cost and add a failure mode.** Every merge today happens with the model seeing all claims for a type at once. Pairwise merging without the global view is precisely the operation that produced the two known wrong merges, and it would run unsupervised with no human-reviewable checkpoint.

**Local filing removes the only mechanism currently detecting absorbed duplicates.** The 57 absorbed fact rows were found because one pass regrouped 133 claims at once. A per-claim filer would file against the resolver only, whose measured miss rate on that table is 60 percent.

**Synthesis candidates are a discard, not a gap,** and the reason is a privacy rule rather than an oversight.

**One objection cut in the proposal's favour:** determinism was invoked as something to preserve and does not exist, so the design should stop paying for it.

---

# PART VIII: THE MINER PLAN

Ordered by measured cost. Each stage is one PR. None requires a rewrite.

## Stage A: Legibility **[Locked] [P0]**

One PR, two changes, zero behavioural effect. Everything after this is unmeasurable without it.

**A-1.** Distinguish "nothing qualified" from "the cap refused." Return a distinct value, carry it into the pass result and `miner_runs.summary`, surface it on the Memory screen. **Do not raise the cap.**

**A-2.** Instrument the resolver. Return a tier discriminator (`exact | alias | fuzzy | context | mint`), histogram per pass, add the counts to the `miner_run` telemetry attrs that `record()` already emits.

## Stage B: Corrections stop forcing a full recompute **[Locked] [P0]**

The largest measured win, and it **blocks Memo Enterprise.** Route both correction kinds through their existing pure graph operations, advance the fingerprint, run no passes, record mode `corrections_only`.

**[Open-Blocking] O-1:** the rename force-write must beat `changeSignature`, and `resolveSurvivorIds` needs rows the people pass would have written. Confirm both are satisfiable outside a derivation run before building.

## Stage C: Port Miine's claim-overlap fallback **[Locked] [P1]**

Insert as a tier between fuzzy and mint. Scope to `canonical_facts`, `canonical_commitments`, `insights` only. Do not apply universally; names already resolve well. Judged against Stage A-2's histogram, which is why A precedes C.

## Stage D: Route interview captures through `writeCapture` **[Locked] [P1]**

Raised from P2. It has already caused a data repair. Small change, one insert site.

## Stage E: Retire in bounded batches **[Locked] [P1]**

Retiring 57 rows across four runs of 15 is safe where 57 at once is not. Requires Stage A-1.

## Stage F: Persist discrepancies and open threads **[Locked] [P1]**

Both tables exist and have never held a row. Discrepancies are already parsed and deduplicated; open threads need parsing that does not exist.

**The work is shaping, not plumbing.** These carry model prose about real people; writing them raw violates 14.5. **[Open-Blocking] O-5.**

Unblocks F-4 and the context-filling game.

## Stage G: Consent-gate the full recompute **[Locked] [P2]**

Not to protect determinism, which does not exist, but because output tokens make a full run irreducibly expensive. Show measured dollars and wall clock from telemetry; require typed confirmation. Add `derivation_version` so a prompt change recomputes only stale rows.

## Stage H: Bound the incremental payload **[Open-Exploratory] [P2, deferred]**

**Deliberately deferred.** At 529 rows the whole layer is 3,000 to 26,000 tokens per pass and an in-memory scan already works. `pg_trgm` 1.6 and `vector` 0.8.0 are both available and neither is installed. **[Open-Blocking] O-3:** what capture rate justifies an index? 41 captures produced 529 rows in seven weeks.

Revisit after Stage B makes incremental the common path and a month of real usage exists. Options then: trigram (nearly free, good for names, poor for sentences), embeddings (the only one addressing fact paraphrase), hybrid (cheap recall filter then embeddings over a shortlist for phrase-shaped types only, mirroring Miine's restriction to five named tables).

## 31. Dropped, with reasons

The three-tier ladder rewrite (exists). Background reconciliation (moves cost, removes the reviewable checkpoint). Determinism as a design goal (lost long ago). Filing separated from synthesis as an architectural split (extraction is already separate and memoized; the remaining conflation is resolution inside the derivation call, addressed by C and H without restructuring). `miner-core` as a shared package.

---

# PART IX: FEATURES

## F-1. Transcript to interview **[Locked] [V0] [P0]**

**The thesis in miniature and the highest-value unbuilt thing in this document.** Upload a transcript or document. Memo generates an interview from it. You take it. The answers land as structured context.

**Blocked by nothing.** Buildable now.

**[Open-Blocking] O-7:** generation at upload time or at click time? Standing rule from Miine: compose-at-click is assembly-only, zero LLM calls at link click time. A research or composition step must be a **prepare** step with visible progress, producing a prepared interview that waits until you press start. A prepared topic is also reusable, which is most of a prompt library for free.

## F-2. Directed interviews and topic entry **[Locked] [V0] [P1]**

Type what you want to talk about. The system researches, composes a small context document, generates a tailored prompt, and saves the interview with that contextualization. Same prepare-step constraint. Spec exists at `interview-features-spec.md` for the typed-topic and library half; the research layer is the addition.

## F-3. Post-recording interview **[Locked] [V0] [P0]**

Record something. At the end, Memo offers a short interview about what you just said, while it is still live in your head. Named in the session as probably the single most implementable feature in it.

## F-4. The context-filling game **[V1] [P2]**

Surfaces discrepancies and open threads and asks you to resolve them. **Blocked on Stage F.**

## F-5. Contradict the miner **[V1] [P2]**

Dispute a claim as an append-only correction. Benefits from Stage B.

## F-6. Interview UI polish **[Locked] [V0] [P1]**

Elapsed timer computed from a timestamp, not a counter, because a backgrounded tab throttles intervals to roughly once a minute. Transcript autoscroll with sticky-bottom behaviour, so scrolling up to read is not overridden. Prompt already written.

## F-7. Split person **[V1] [P2]**

See section 25. Two live cases need it.

## F-8. Read-only follow-up calendar on Today **[V1] [P2]**

Low risk, previously Phase 3.

---

# PART X: SURFACES

## S-1. Native iOS Swift client **[Locked] [V0] [P0]**

**Consumption everywhere, administration on web forever.** On iOS: sign in, scope switch, capture by memo and interview, Today, Memory read, promotion. Web only, permanently: workspace creation, invites, membership, cost ceilings, observability console, corrections.

Because the API is scope-parameterized, an iOS client supporting one scope supports both for free. The expensive part of Enterprise is the admin surface and none of it belongs on a phone, so there is no "iOS is personal only" fallback; it would not be cheaper.

Separate repo `memo-ios`. SwiftUI, iOS 17 minimum, SPM only, `supabase-swift` and `elevenlabs-swift-sdk`. One app, one bundle id, one listing, scope toggle inside.

**Audio session is scheduled, not discovered.** `.playAndRecord`, `.voiceChat`, `[.allowBluetooth, .defaultToSpeaker]`, interruption and route-change handling, conversation ends cleanly on backgrounding with state saved, no background audio mode in V0, input level meter on screen.

**All writes and mine dispatch through `/api/v1/*`.** Reads may go direct to Supabase under RLS. If Swift writes captures directly there will be two write paths within a month and 14.1 dies quietly.

Offline queue for voice memos only; interviews require connectivity by nature.

App Store items scheduled rather than discovered: microphone usage description, privacy manifest, consent screen before first recording, TestFlight only in V1.

## S-2. macOS **[V1] [P2]**

Named alongside iOS in the session. Not specced.

## S-3. Wispr Flow MCP integration, "Memo Flow" **[Locked] [V1] [P1]**

An extra button in the Wispr surface routing dictation into Memo. **Strongest reaction of any integration idea in the session**, because dictation is already where thinking lands, making it the lowest-friction capture point in the system.

**[Open-Blocking] O-6:** does Wispr Flow expose an MCP surface or extension point? Verify before specifying.

## S-4. Phone and voice line **[Open-Exploratory] [V2]**

Call Memo and talk on speaker. The IVR riff (1 interview, 2 recording, 3 compiling, 4 playback) is a joke that is also a real spec. Voice-first with no app open is genuinely differentiated.

## S-5. Wearable capture **[Parked]**

Litigated and tabled. Camera dropped immediately as dystopian and as generating far more data than can be usefully ingested. Always-on rejected for actuated capture, exception for solo focused work. Behavioural cost: self-censorship and a chilling effect on speech around others. Data security scales with exposure, especially through a public model; mitigation would be own GPU, own inference, own MCP endpoint.

**Where it landed: the phone wins.** Already controlled, already always present, and the constraint is app quality rather than hardware. Revisit only if phone capture proves insufficient in practice.

---

# PART XI: MEMO ENTERPRISE

Full spec in `memo-spec-v1.md`. Summarised because the miner plan changes its cost assumptions.

**Scope at capture time, not ACL at node time. [Locked]** Every capture carries a `scope_id`. The miner runs per scope. A workspace graph is built only from captures directed at it. Consequence to accept: the same person exists as two unrelated entities across personal and workspace graphs; cross-scope linking is V2 and is an overlay, never a merge.

**The one-way wall. [Locked]** Personal to workspace never happens, by any feature, admin action or export. Workspace to personal happens only through an explicit user action creating a new personal **capture** pointing at the workspace node, resolved by the personal miner. No canonical row is ever copied.

**Authorization is by scope membership, not user id.** After Phase 1, `user_id` survives only as authorship metadata on raw rows.

**Every write names its scope explicitly.** No server-side or session-side "current scope" on a write path, because a session-stored scope is how a capture lands in the wrong graph after a background-and-foreground cycle, and given the one-way wall that failure is unrecoverable.

**Phase 1 is unblocked and waiting.** Its precondition was a current graph, a completing miner, and no pending corrections. That condition is now met. 0021 and 0022 applied, harness 8 of 8, next free migration 0023. Phase 1 adds `scopes` and `scope_members`, backfills a personal scope per user, adds `scope_id` to 33 tables (not `observability_events`, not `user_profiles`), and adds v2 RLS policies alongside v1 behind a flag.

**Permissive RLS policies are OR'd.** Adding a v2 policy alongside v1 makes access the union. Safe only because the backfill is one-to-one and no workspace exists. **Workspace creation must not ship before Phase 2 drops the v1 policies.**

**Enterprise makes Stage B non-optional.** A workspace with several members generates corrections continuously. At workspace scale, a correction forcing a full recompute is not an annoyance, it is a denial of service on your own product.

---

# PART XII: THE HEARTBEAT PATTERN

Raised in the session as "how do you write motivation into an agent" and correctly dissolved: **what you want is persistence, and persistence is mechanical.**

The mechanism: a scheduled agent picks up jobs, runs against a max tool-call or credit budget, writes a handoff document, spawns a successor, moves on. Plus a gate for the human interrupt. **Heartbeat gives persistence, gate gives control.**

Two refinements: introduce randomness into what the heartbeat picks up so it does not converge on the same work every cycle, and treat prompt engineering as accretive, accumulating good questions and behaviours rather than writing a one-shot spec.

**Two constraints on the questioning layer.** Cold start: ideas generated in bulk die because nothing picks them back up, so the system's job is to re-approach them with questions rather than let them decay. And do not abandon the seeds: the agent must retain and periodically resurface prior ideas rather than starting fresh each session. **That is a persistence requirement, not a UX nicety.**

**[Open-Exploratory] [V2].** Reusable across Memo, the TMI PM agent, and anything else run autonomously.

---

# PART XIII: SECOND MARKET

Deliberately separate from the main thread.

People would want their own interview agents, contextualized to elicit specific information. The framing: **reaching side versus settling side.** Today you are the one reaching out, fundraising and BD; the decision-maker on the receiving end would want to offer callers a choice between leaving a voicemail and taking an interview that extracts what the caller needs, structured, on the decision-maker's terms.

**A different market from the agent gate.** Asynchronous communication infrastructure rather than agent tooling. Both fall out of the same interview-agent primitive, which is the argument that the primitive is the business.

Not specced. Recorded so it is not rediscovered.

---

# PART XIV: INCIDENT LOG

Each produced a standing rule. Kept so the rules are not read as arbitrary.

**2026-07-02, capture duplication.** Four duplicate captures required a retraction repair. **Two of the four were the interview capture bypass**, which remains unfixed. See section 28.

**2026-07-06 to 2026-08-07, the recompute loop.** Seven corrections forced a full recompute; the full failed at the people pass; the fingerprint and markers only advance if every pass succeeds, so the corrections stayed pending and forced a full again. Three iterations, thirty two days of a stale graph. Broken by PR #51.

**The people-pass transcription failure.** The model was asked to transcribe 173 opaque 36-character uuids per pass. It spliced the first eight characters of the correct id onto the tail of a different real id, twice, at the identical break point. The provenance guard caught it. Fixed by replacing uuids with 4-character random handles from a 32-character alphabet, translated back before validation. **Zero rejected ids in the 32 calls since.**

**578 orphan rows.** The security harness created throwaway users, seeded canonical rows (firing the history trigger), then deleted the users. `canonical_history` is hard append-only so teardown could never remove them, and once the user was gone no RLS predicate could reach them. Roughly fifty runs, 97 vanished users. The harness header claimed "Leaves NO residue." Fixed by permanent guard accounts plus archive-then-purge in 0021. **Origin of rule 14.4.**

**Three columns carrying model prose.** `miner_runs.error`, `miner_runs.summary` (19 discrepancy items, roughly 6,900 characters about the operator's family and career), and `telemetry_events.attrs` (verbatim `routing_hint`). Found only by sweeping all 93 text and jsonb columns; a targeted guard found 1 of 3. **Origin of rules 14.5 and 15.6.**

**2026-08-07, direct push to main.** An agent pushed a destructive migration to main with no PR and no review, one hour after writing the rule it violated, because it assumed it was on a feature branch and never ran `git branch --show-current`. The migration applied and the outcome was verified safe after the fact. **Origin of rule 15.2 and of the pre-push hook plus branch protection.**

## 32. Hard-won debugging lessons

**Diagnose from real evidence before acting.** Multiple confidently-wrong analyses were caught this way: a "graph is corrupted, 238 duplicates" alarm was an unfiltered query counting six throwaway test users; a profile render error was a 1 MB Server Action body limit, not a missing migration; the microphone bug was Chrome capturing a "Microsoft Teams Audio" virtual device, not code.

**The microphone.** In-app browsers opened from a text or email link block the mic; the operator must type the URL in a real browser. A virtual audio device selected as system input captures silence. The app now shows a diagnostics readout and an input-level meter.

**Email.** Supabase's built-in sender is unreliable, so custom SMTP is required for recovery. Account creation sends no email at all, so unsticking a user is often just clearing their auth row and having them create fresh. **That pattern now conflicts with rule 14.4 and must be replaced with disabling rather than deleting.**

**A prompt-adjacent lesson.** Three separate agent artifacts checked only for the failure someone had already imagined: a regex matching the known shape, a harness testing isolation but never content, an audit capped at 24 findings. The general form is rule 15.6.

---

# PART XV: SEQUENCING

| Order | Item | Why here |
|---|---|---|
| 1 | Merge PR #52, fold findings into HANDOFF and CLAUDE.md | The audit is the basis of everything below and is unmerged |
| 2 | Stage A, legibility | Zero behaviour change, makes everything after measurable |
| 3 | F-6, interview timer and autoscroll | Touches no data, already specced, ships alongside |
| 4 | Stage B, corrections | Largest measured win. Blocks Enterprise. |
| 5 | Stage D, interview capture guard | Already caused a repair. Small. |
| 6 | F-1, transcript to interview | The thesis, testable in a week, unblocked |
| 7 | Stage C, claim-overlap tier | Judged against Stage A's histogram |
| 8 | Phase 1, scope migration | Precondition now met |
| 9 | F-3, post-recording interview | Most implementable feature in the session |
| 10 | Stages E and F | Retirement batching, synthesis persistence |
| 11 | S-1, iOS | Largest single build |
| Later | Stage G, Stage H, F-2, F-4, F-7, S-3 | Each has a stated trigger condition |

**Three PRs stand between here and a system where a rename is free, a memo costs pennies, and a full recompute is a deliberate quarterly choice.**

---

# PART XVI: OPEN ITEMS

| ID | Question | Blocks |
|---|---|---|
| O-1 | Can the rename force-write and `resolveSurvivorIds` ordering be satisfied outside a derivation run? | Stage B |
| O-2 | Resolver tier distribution? | Judging Stage C. Answered by Stage A-2. |
| O-3 | What capture rate justifies a retrieval index? | Stage H |
| O-4 | What does bounding incremental context cost in recall? | Stage H |
| O-5 | How are discrepancy `subject` and `description` shaped without losing meaning? | Stage F |
| O-6 | Does Wispr Flow expose an MCP or extension surface? | S-3 |
| O-7 | Where does a prepared interview live before it is taken? | F-1, F-2 |
| O-8 | What vocabulary do users get for expressing gate criteria, "interrupt me when ___"? | The clip product |
| O-9 | Is mpetersen1@berkeley.edu an expected account? | Allowlist integrity |
| O-10 | What is `confirmations` for? It has no writer and no reader. | Nothing, but it is unexplained |

**O-8 is the moat question from Part II and it is a product question, not an engineering one.** It should be answered by Todd and Nate, not by an agent.

---

# PART XVII: WHAT THIS DOCUMENT DOES NOT COVER

Stated so the denominator is honest.

The app read surfaces (`lib/chat/retrieval.ts`, `lib/companion/*`, `lib/people.ts`) were noted as canonical readers and not audited. The interview and capture surfaces were traced only as far as the capture write. Miine's `stage-summaries.ts`, `compose-rounds.ts` and `summaries-dump.ts`, roughly 1,450 lines, were not read; they sit outside the mining path. Thinking-token share is unmeasurable: the SDK returned null for `output_tokens_details.thinking_tokens` on all 32 calls, so `MINER_EFFORT=high` cannot currently be evaluated. Cost attribution assumes the measured chars-per-token ratio holds within a pass across batches, validated on batch 1 of every pass in run 8 and not on later batches. No ElevenLabs or Scribe costs are included anywhere in this document. The `usage_ledger` specified in `memo-spec-v1.md` does not exist yet, so all cost figures come from `telemetry_events`.
