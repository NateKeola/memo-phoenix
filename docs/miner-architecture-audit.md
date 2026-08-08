# Miner architecture audit

Read-only audit. No application code was changed, no migration run, no miner run, no database write.

Date: 2026-08-08. Repository state: branch `miner-architecture-audit` off `main` at `1cc76b9`.

Evidence classes used below: `file:line` with a verbatim quote, a live SQL result against the dev project `azlobwtiptvarfeukzcv`, or a GitHub Actions log line. Anything not carrying one of those is marked "not determined".

**Two documents this audit was asked to diff against do not exist in the repository.** `docs/miner-rearchitecture-spec.md` is absent (`ls docs/` returns 16 entries, none matching `rearch`). `usage_ledger` does not exist as a table, a column, or a code reference (grep across the repo returns zero hits). Part E is therefore written to stand alone rather than as a diff, and A10 is sourced entirely from `telemetry_events` rows of `event_type = 'llm_call'`.

**Scope of the two measured runs.** All per-run numbers come from the two consecutive full recomputes of 2026-08-07 and 2026-08-08, GitHub Actions run ids `31225406094` (referred to as run 8) and `31229780169` (run 9). Both completed with status `done`.

---

# Part A: the Memo miner as it exists today

## A1. Pipeline topology

Fourteen stages. Entry points and process boundary:

| # | Stage | Entry point | Runs in |
|---|---|---|---|
| 1 | Transcription (voice only) | `app/api/capture/memo/route.ts`, via `lib/stt/elevenlabs.ts` | App only |
| 2 | Capture write | `writeCapture`, `lib/captures.ts:52`, **and one bypass**, see below | App only |
| 3 | Run claim and lock | `mineWithLock`, `packages/miner-core/src/run.ts:184` | Either |
| 4 | User-id assertion | `assertUserId`, `run.ts` | Either |
| 5 | Capture read, exclusions applied | `readCaptureIds` / `readExcludedCaptureIds`, `stage-common.ts:22` | Either |
| 6 | Extraction, one model call per capture | `extractCapture`, `extract.ts` | Either |
| 7 | Extraction memoization | `miner_state` scope `extract:<captureId>` | Either |
| 8 | Mode decision (full / incremental / no-op) | `runIncrementalDerivation`, `incremental.ts:522` | Either |
| 9 | Derivation passes, in order | `runDerivation`, `derive.ts:533` | Either |
| 10 | Loser supersession | `resolveSurvivorIds` then `supersedeLosers`, `derive.ts:601-602` | Either |
| 11 | Rename force-write | `applyRenameLabels`, `derive.ts:612` | Either |
| 12 | Absorbed-row retirement | `retireAbsorbedRows`, `stage-common.ts:520` | Either |
| 13 | Freshness reconciliation | `supersedeFromDiscrepancies` then `reconcileFreshness`, `derive.ts:713-714` | Either |
| 14 | Run bookkeeping and heartbeat | `mineWithLock`, `run.ts` | Either |

**Derivation pass order**, from `runDerivation` (`derive.ts:533` onward), 8 passes:

1. `canonical_people` (`derive.ts:577`)
2. `canonical_places_orgs` (`derive.ts:587`)
3. `canonical_projects` (`derive.ts:624`)
4. `canonical_events` (`derive.ts:633`)
5. `canonical_facts` (`derive.ts:642`)
6. `canonical_relationships` (`derive.ts:658`)
7. `canonical_commitments` (`derive.ts:664`)
8. `insights` (`derive.ts:673`)

Stages 10 and 11 run between pass 2 and pass 3, so that stages B and C read corrected people labels.

**Correction to stage 2, found by adversarial verification of this audit's own first draft.** `captures` is written from **2 insert sites of 12 `.from('captures')` sites in the app and miner** (the other 10 are reads). Only one goes through `writeCapture`. The interview path inserts directly (`app/api/interview/end/route.ts:83`):

```ts
  const { data: cap, error } = await supabase
    .from('captures')
    .insert({
      user_id: user.id,
      mode: 'interview',
```

`writeCapture` applies two guards that this path therefore does not get: the size cap `MAX_CAPTURE_CHARS` at `lib/captures.ts:38`, default 100,000 chars, enforced at `lib/captures.ts:57`; and the content-dedup window `DEDUP_WINDOW_MS` at `lib/captures.ts:44`, 10 minutes, enforced at `lib/captures.ts:66`. **Interview transcripts are the longest capture type in the system and are the one capture type with neither a length cap nor a double-submit guard.**

Capture-write denominator: 6 paths, 5 through `writeCapture` (`app/context-actions.ts:29`, `app/capture/text/actions.ts:23`, `app/people/new/actions.ts:24`, `app/people/new/actions.ts:53`, `app/api/capture/memo/route.ts:71`) and 1 direct.

**The process boundary.** `mine()` and everything under it is a single Node process. There are exactly three ways to start it, and no other:

- `app/api/miner/run/route.ts`, in a Vercel serverless function with `maxDuration = 300`. It runs `mineWithLock` inline **only** when the corpus is at or under `MINER_INLINE_MAX_CAPTURES`; otherwise it dispatches to the Action.
- `.github/workflows/miner.yml`, which runs `npm run miner` on a GitHub runner with no `timeout-minutes` set, therefore the GitHub default of 360 minutes.
- The local CLI, same code path.

The lock is what makes the boundary safe. `mineWithLock` inserts a `miner_runs` row guarded by a partial unique index on `status='running'`, so a collision returns `already_running` rather than a second concurrent mine, regardless of which of the three runtimes fires.

Both measured runs used the Action path: `trigger = 'manual'`, durations 38.3 and 30.9 minutes, both far past the 300-second inline ceiling.

## A2. Data model

**Denominator.** `packages/miner-core/src` contains 21 files. `admin()` appears at **43 call sites across 10 of those 21 files**: `corrections.ts` 9, `stage-common.ts` 10, `freshness.ts` 6, `extract.ts` 5, `incremental.ts` 5, `resolve-store.ts` 3, `run.ts` 2, `seed.ts` 1, `supabase.ts` 1, `telemetry.ts` 1.

A naive grep for `.from('` returns only 9 distinct tables and would be wrong. 63 `.from(` occurrences exist; **14 of them are `Array.from` and are not database calls at all**, and 25 more take a variable table name. The true table set must be resolved through the table-name constants.

**23 distinct tables of the 35 public base tables**, grouped:

*Ground truth, append-only (8):*

| Table | Written by | Read by | Trigger |
|---|---|---|---|
| `captures` | App (`writeCapture`) | Miner (`readCaptureIds`) | `captures_append_only` |
| `corrections` | App (`app/people/actions.ts` only) | Miner (`readPeopleCorrections`) | `corrections_append_only` |
| `confirmations` | Nothing found | Nothing found | `confirmations_append_only` |
| `raw_people`, `raw_places_orgs`, `raw_projects`, `raw_events`, `raw_facts`, `raw_relationships`, `raw_commitments`, `raw_collection_mentions` | Miner (`extract.ts:182`) | Miner (`readRawClaims`) | one `*_append_only` each |

That is 8 raw tables plus `captures`, `corrections`, `confirmations`. `RAW_TABLES` at `freshness.ts:42-51` enumerates the 8.

*Canonical, mutable by the miner (8):* `canonical_people`, `canonical_places_orgs`, `canonical_projects`, `canonical_events`, `canonical_facts`, `canonical_relationships`, `canonical_commitments`, `insights`. Enumerated as `FRESHNESS_TABLES` at `freshness.ts:55-64`. Written only by the miner. Read by the miner and by every app read surface.

`canonical_relationships` is the only edge table. Its endpoints live in `data.source_id` / `data.target_id`, not in typed columns.

*State (4):* `miner_state` (extraction markers, incorporated markers, per-pass input hashes, the corrections fingerprint), `miner_runs` (lock, audit, heartbeat, summary), `entity_aliases` (resolver alias map), `capture_exclusions` (retraction).

*Telemetry (2):* `telemetry_events` (append-only, `telemetry_events_append_only`), `observability_events` (service-role write only).

*History (1):* `canonical_history`, append-only via `canonical_history_append_only`, written only by the `snapshot_canonical` trigger, never by miner code.

**Trigger census, read live from `pg_trigger`.** 13 `forbid_mutation` triggers, all `tgenabled = 'O'` (enabled): `canonical_history`, `captures`, `confirmations`, `corrections`, `telemetry_events`, and the 8 `raw_*` tables. 10 `snapshot_canonical` triggers: the 7 `canonical_*` node and edge tables, `insights`, `collections`, `collection_items`.

**Identity scheme.** Two mechanisms coexist, and the choice is made at `derive.ts:201-206`:

```ts
    const id = resolver
      ? resolver.resolve(name, nodeAliases, contextKey).id
      : split
        ? canonicalPersonId(userId, split.first, split.last)
        : canonicalId(userId, cfg.canonicalTable, name)
```

`canonicalId` is a UUIDv5 over `(userId, table, normalizeLabel(label))`, so it is content-derived and stable for a stable label. `canonicalPersonId` reconstructs the label from first plus last name and hashes that, which is why turning first-and-last identity on caused no id churn. `canonical_relationships` never uses the resolver: `derive.ts:346` computes `canonicalId(userId, table, key)` where `key = source|target|relation`, so an edge id is fully determined by its endpoints and verb.

When the resolver is active and misses every tier, it mints `randomUUID()`. That id is **not** content-derived. The measured consequence is in A7.

## A3. The resolver, in full

`STABLE_IDENTITY` is default on: `resolve-store.ts:19`, `export const STABLE_IDENTITY = process.env.MINER_STABLE_IDENTITY !== '0'`. `.github/workflows/miner.yml` does not set the variable, so both measured runs ran with the resolver active.

**Candidate set.** `buildResolver` reads the live current rows of the target table, unbounded (`resolve-store.ts:33-39`):

```ts
export async function buildResolver(userId: string, table: string, ex: RowExtract = {}): Promise<Resolver> {
  const { data, error } = await admin()
    .from(table)
    .select('id, label, data')
    .eq('user_id', userId)
    .is('valid_to', null)
```

**Alias layer.** `readAliasMap` (`resolve-store.ts:54-71`) loads `entity_aliases` scoped to the user and the table, degrading to an empty map if the table is absent. Live population, 686 rows for the real user: people 132, places_orgs 119, facts 118, events 79, commitments 76, projects 45, insights 29.

**Ladder order**, from `resolution.ts`: exact normalized label, then persisted or in-run alias, then conservative token-Jaccard fuzzy at `MINER_RESOLVE_FUZZY` default 0.8 (`resolution.ts:36`, `STRICT_FUZZY`), with an ambiguity margin guard, then mint a random uuid. Commitments additionally pass a context key (`derive.ts:165`, `contextOf: (d) => asString(d.person_id)`); context agreement relaxes the fuzzy bar to `CONTEXT_FUZZY` 0.5 (`resolution.ts:37`) and context disagreement is a hard block that overrides even an exact text match.

**Which passes build a resolver: 7 of 8.** `runNodePass` builds one for each of its 6 tables (`derive.ts:161-167`) and `runInsightsPass` builds one keyed on `data.statement` (`derive.ts:460-462`). `runRelationshipsPass` builds none, by design, because edge ids are derived from already-resolved endpoint ids.

**Tier distribution: NOT DETERMINED.**

The question "what fraction of claims resolved at each tier" cannot be answered from anything the system records. Grepping `packages/miner-core/src` for resolver-tier logging returns nothing, and the live `telemetry_events` table contains 21 distinct `event_type` values for this user, none of which is resolver-related: `miner_run` 151, `companion_surfaced` 79, `llm_call` 32, `interview_started` 27, `capture` 24, `tool_call` 21, `interview_ended` 18, `correction` 17, `miner_run_triggered` 11, `companion_state` 8, `invite_created` 7, `chat_query` 7, `corrections_applied` 6, `context_add` 4, `invite_revoked` 4, `error` 2, `profile_update` 2, `companion_tracking` 1, `recovery_link_created` 1, `contact_create` 1, `companion_brainstorm` 1.

The `Resolver.resolve` return value carries the resolved id and nothing that names the tier that produced it. **What would determine it:** returning a `tier` discriminator from `resolve()` (`'exact' | 'alias' | 'fuzzy' | 'context' | 'mint'`), accumulating a per-pass histogram in `runNodePass`, and adding those five counts to the `miner_run` telemetry attrs that `record()` already emits at `derive.ts:541`. That is an additive instrumentation change with no behavioural effect and it is the single highest-value missing measurement in the system.

The one tier-adjacent fact that **is** measurable is the mint rate, because a minted id is a v4 uuid and a derived id is v5. See A7: 190 of 529 live rows, 35.9%, carry a minted id.

## A4. Payload composition, exactly

This is the section the re-architecture rests on, and the headline finding contradicts the assumption behind it.

**The incremental path sends the entire canonical layer for the type. It does not send a bounded subset.**

`readCanonicalNodes` (`stage-common.ts:91-100`) applies no limit, no ranking, and no filter beyond user scope and currency:

```ts
  const { data, error } = await admin()
    .from(table)
    .select('id, label, data, summary, source_claim_ids')
    .eq('user_id', userId)
    .is('valid_to', null)
    .order('id')
```

All 6 incremental node passes call it with no bound (`incremental.ts:600, 615, 636, 648, 660, 684`):

```ts
      context: await readCanonicalNodes(userId, 'canonical_people'),
      context: await readCanonicalNodes(userId, 'canonical_places_orgs'),
      context: [...aNodes, ...(await readCanonicalNodes(userId, 'canonical_projects'))],
      context: [...aNodes, ...(await readCanonicalNodes(userId, 'canonical_events'))],
      context: await readCanonicalNodes(userId, 'canonical_facts'),
      context: [...aNodes, ...(await readCanonicalNodes(userId, 'canonical_commitments'))],
```

**The full path sends less context than the incremental path.** 3 of the 6 full node passes send an empty array (`derive.ts:580, 590, 645`: `context: []` for people, places_orgs, facts) and the other 3 send `aNodes`, which `derive.ts:615-618` builds as people plus places only. **No full pass is ever shown its own table's existing rows.** That asymmetry is not documented anywhere in the repo.

**Measured payload decomposition.** Built by reconstructing each `buildUser` body from live data read-only and measuring `JSON.stringify` lengths. The reconstruction validates exactly against recorded telemetry for the three passes with empty context: people 31,001 chars reconstructed against 31,001 recorded, places_orgs 18,739 against 18,739, facts 14,688 against 14,688. The three `aNodes` passes differ by a constant 214 chars because the graph moved between run 8 and the measurement. Tokens use the per-pass chars-per-token ratio measured from the same telemetry rows, where `tokens_in` is the uncached user message and `cache_write` / `cache_read` is the system block.

| Pass | Full: ctx nodes | Full: total chars | Full: ~tokens | Full: ctx share | Incr: ctx nodes | Incr: ~tokens | Incr: ctx share |
|---|---|---|---|---|---|---|---|
| canonical_people | 0 | 31,001 | 13,052 | 0% | 68 | 3,219 | 92% |
| canonical_places_orgs | 0 | 18,739 | 8,106 | 0% | 85 | 4,221 | 95% |
| canonical_projects | 153 | 21,844 | 11,463 | 75% | 180 | 11,116 | 96% |
| canonical_events | 153 | 27,316 | 14,044 | 60% | 205 | 11,703 | 98% |
| canonical_facts | 0 | 14,688 | 7,313 | 0% | 110 | 6,717 | 96% |
| canonical_commitments | 153 | 23,368 | 12,297 | 70% | 192 | 11,473 | 98% |
| canonical_relationships | 342 | 50,435 | 26,401 | 78% | 342 | 26,401 | 78% |
| insights | 417 | 109,805 | 51,780 | 100% | no incremental pass | | |

Incremental columns simulate folding one capture, using 3 claims.

**Reading of that table.** Folding a single new capture costs roughly **74,850 input tokens across 7 passes, of which 92 to 98 percent is existing canonical context re-sent from scratch on every fold.** The claims themselves are 400 to 700 characters. The incremental path is already almost entirely a context-shipping mechanism, and its cost is a function of graph size rather than of how much new material arrived.

**Other payload sections.** `already_emitted` is a list of labels already returned in earlier batches of the same pass, and it is not a dedup mechanism at the claim level. `batch_limit` is `pageLimit(table)`, 15 for the three verbose tables and 40 otherwise. Corrections never enter the payload; they are applied in code. Aliases enter only inside `canonical_nodes[].aliases`. Prior summaries enter only for insights, inside `canonical_layer.nodes[].summary`.

**Claims already consumed by earlier batches remain in the payload.** `derive.ts:134` serializes the full `claims` array on every batch, and the only signal the model gets about prior batches is the label list. This was investigated on 2026-08-07 and consumption filtering was rejected as unsafe, because claim consumption is not exclusive: 4 of 8 canonical tables show a single claim cited by more than one node in the same pass.

## A5. Incremental mechanics

The branch, `incremental.ts:532-545`:

```ts
  const captures = await readCaptureIds(userId)
  const incorporated = await readIncorporatedSet(userId)
  const unincorporated = captures.filter((id) => !incorporated.has(id))

  // Corrections (rename/merge) are global; a NEW correction forces a full recompute.
  const corrections = await readPeopleCorrections(userId)
  const peopleRewrite = buildPeopleRewrite(userId, corrections)
  const lastFp = (await getState(userId, CORR_FP_SCOPE)) ?? ''
  const correctionsChanged = peopleRewrite.fingerprint !== lastFp

  const baselineExists = incorporated.size > 0

  // --- FULL: baseline (first run on this graph) or a corrections change ---
  if (!baselineExists || correctionsChanged) {
```

Three state mechanisms, all in `miner_state`:

- **Incorporated markers**, scope `incorporated:<captureId>`, written by `markIncorporated` only after `runDerivation` returns. Live: 41 markers against 41 captures, of which 2 are excluded, giving 39 admissible. That matches the `captures = 39` both runs recorded.
- **Corrections fingerprint**, scope `incremental:corrections_fp`, `sha256(canonicalJson(corrections.map(c => ({k: c.kind, p: c.payload}))))` at `corrections.ts:161-163`. Live value `253d0059dcb87441...`, recomputed independently with the real `identity.ts` and equal.
- **Per-pass input hash**, scope `derive:<table>`, covering claims, context key, corrections fingerprint and the identity mode (`derive.ts:98-104`). A hit skips the pass entirely. In run 9, `canonical_places_orgs` and `canonical_facts` were skipped this way, which is why run 9 made 12 model calls against run 8's 20.

**At the pass level, incremental and full are structurally the same code shape.** `incNodePass` and `runNodePass` both build claims, call `paginatedCollect` with the same prompt and the same validator, build a resolver, and write. Two differences exist and only two:

1. The claim set. `runNodePass` uses `readRawClaims` (all claims); `incNodePass` uses `readNewRawClaims` (claims of unincorporated captures only).
2. The write step. `runNodePass` calls `writeCanonical` on the emitted rows directly and then `retireAbsorbedRows`. `incNodePass` first calls `mergeEmitted` against `readCurrentForMerge` so that `source_claim_ids` unions rather than replaces, and it never calls `retireAbsorbedRows`.

The context argument also differs, as A4 documents, but that is a call-site argument rather than a difference in the pass.

There is **no incremental insights pass**. `runIncrementalDerivation` never calls `runInsightsPass`.

## A6. Write semantics

`writeCanonical` decides per row (`stage-common.ts:461-479`) between insert, kept-retired, update and unchanged. The decision key is `changeSignature` (`stage-common.ts:386-388`):

```ts
function changeSignature(row: { source_claim_ids: string[]; temporality: string }): string {
  return canonicalJson({ source_claim_ids: [...row.source_claim_ids].sort(), temporality: row.temporality })
}
```

**The label is not in the signature.** The comment above it states the exclusion is deliberate, to stop the model's rewording of cosmetic fields from rewriting every row. This single fact is what makes `applyRenameLabels` necessary, see A8.

**The absorbed-row test** (`stage-common.ts:553-558`):

```ts
  const candidates = current.filter(
    (r) =>
      !emittedIds.has(r.id) &&
      r.claims.length > 0 &&
      r.claims.every((c) => attributed.has(c) || excludedClaimIds.has(c))
  )
```

**The safety cap** (`stage-common.ts:561-568`):

```ts
  const cap = Math.max(5, Math.floor(current.length * 0.5))
  if (candidates.length > cap) {
    console.warn(
      `[miner] retirement SKIPPED for ${table}: ${candidates.length} rows qualified ` +
        `(> safety cap ${cap} of ${current.length} current); refusing a mass retirement`
    )
    return none
  }
```

**A live row that no pass re-emits and that fails the absorbed test stays live forever.** Nothing else retires it. There is no age-out, no confidence floor that removes rows, and read-time decay changes only the reported confidence.

**The known defect is confirmed.** `none` is `{ retired: 0, mapping: new Map() }` (`stage-common.ts:533`), returned both when `candidates.length === 0` (line 545) and when the cap refuses (line 554). `miner_runs.summary` therefore records `retired: 0` in both cases and the two are indistinguishable in any persisted record. The only distinguishing evidence is a stdout line that exists solely in the GitHub Actions log:

```
run 8  [miner] retirement SKIPPED for canonical_projects: 18 rows qualified (> safety cap 14 of 28 current)
run 8  [miner] retirement SKIPPED for canonical_facts:    57 rows qualified (> safety cap 55 of 110 current)
run 9  [miner] retirement SKIPPED for canonical_projects: 17 rows qualified (> safety cap 13 of 27 current)
```

`canonical_facts` exceeded its cap by **two rows**. Those 57 rows passed the absorbed test, meaning every claim each cites was re-attributed to a row the pass emitted, and they remain live. This is the mechanical cause of the largest divergence between live row count and emitted row count in the graph: facts 110 live against 53 emitted, projects 27 against 10.

## A7. Determinism

**The graph is not reproducible from claims. It is path-dependent, and the degree is measurable.**

A UUIDv5 carries `5` in the version nibble and a UUIDv4 carries `4`. Every content-derived id is v5 and every resolver mint is v4, so the split is directly countable. Live rows, per table:

| Table | v5 content-derived | v4 minted | total | minted share |
|---|---|---|---|---|
| canonical_people | 56 | 12 | 68 | 17.6% |
| canonical_places_orgs | 62 | 23 | 85 | 27.1% |
| canonical_projects | 25 | 2 | 27 | 7.4% |
| canonical_events | 25 | 27 | 52 | 51.9% |
| canonical_facts | 44 | 66 | 110 | 60.0% |
| canonical_commitments | 5 | 34 | 39 | 87.2% |
| canonical_relationships | 75 | 0 | 75 | 0% |
| insights | 47 | 26 | 73 | 35.6% |
| **total** | **339** | **190** | **529** | **35.9%** |

Three findings follow.

1. **35.9 percent of the live graph has an id that exists only because of the order in which past runs happened.** Re-mining from scratch would mint different uuids for those rows. Anything keyed on a canonical id from outside the miner, including `companion_state.commitment_id`, `superseded_by`, and `insights.affected_entity_ids`, is keyed on a path-dependent value for that 35.9 percent.
2. `canonical_relationships` is 0 percent minted, because it never uses the resolver and derives ids purely from endpoint ids and the verb. It is the only fully content-derived table, and its content-derivation is second order, since the endpoint ids it hashes are themselves 35.9 percent path-dependent.
3. `canonical_commitments` at 87.2 percent minted is the extreme case, consistent with the context-key hard block described in A3 discarding exact matches whenever a commitment's linked person id moves.

Two further sources of non-determinism, neither quantified here. Model output varies run to run, which is the reason `docs/incremental-equivalence-result.txt` had to define equivalence on structural invariants rather than byte equality. Ordering effects are partially controlled: `readRawClaims` and `readCanonicalNodes` both carry `.order('id')`, added because unordered reads made the input hashes nondeterministic, but batch composition within a pass still depends on what the model chose to emit first.

**Verdict: an incremental-first design would surrender a nominal property, not a real one.** The current architecture already does not have reproducibility, and 35.9 percent is not a rounding error.

## A8. Corrections

**Two kinds exist. Denominator: 2 of 2 insert sites into `corrections` across the entire application**, both in `app/people/actions.ts` (line 32 `kind: 'rename_person'`, line 69 `kind: 'merge_people'`). `PEOPLE_KINDS` at `corrections.ts:19` matches. No other kind is written anywhere, and `confirmations` has no writer at all.

| Kind | Graph change | Blast radius, measured | Model calls today | Model calls in principle |
|---|---|---|---|---|
| `rename_person` | Label rewrite before id derivation, plus a force-write of the label | 1 person row relabeled, plus its aliases | Forces a full recompute: 20 calls in run 8 | 0 |
| `merge_people` | Loser superseded onto survivor, edges retired, references repointed | 1 row retired, N edges retired, M references repointed | Same full recompute | 0 |

Neither correction requires a model call to express. Both currently cost an entire recompute, because `correctionsChanged` forces the full branch. Run 9 is the measured instance: a single `rename_person` filed at 23:52 caused a 30.9 minute, 12 call, $4.78 full recompute.

**Why `applyRenameLabels` runs after the people pass.** It is a force-write that exists to beat the change signature, and the evidence is explicit at both ends.

The call-site comment (`derive.ts:605-612`):

```
  // Force the target label onto a rename that resolved in place (same id kept; the
  // change-signature excludes the label, so a pure relabel is otherwise skipped and
  // the rename never lands).
```

The mechanism it beats is `changeSignature` at `stage-common.ts:386`, quoted in A6, which contains only `source_claim_ids` and `temporality`. The people pass does compute the corrected label, because `derive.ts:188` rewrites the surface form before the id is derived. But when a renamed person's claim set has not changed, `writeCanonical` classifies the row `unchanged` and never issues the update, so the computed label is discarded and the old label survives in the database.

Git history confirms the ordering is a bug fix rather than a design: `328ebeb fix(corrections): renames now land and clear pending on the next mine`, followed by `c772795 fix(corrections): only relabel rename_person targets in place, never merge losers`.

The "after" is required for two reasons stated in the same comment. `resolveSurvivorIds` must read the rows the people pass just wrote, and the relabel must land before `aNodes` is read at `derive.ts:615` so that stages B and C see the corrected label.

**`split_person`, unbuilt.** Every existing correction is a label rewrite applied before id derivation, which is why both fit `buildPeopleRewrite`. A split is not a label operation. It requires partitioning one row's `source_claim_ids` into two sets and deriving two rows from them, which means: a payload carrying a claim-level partition rather than two labels; a new branch in `derive.ts` that overrides the model's grouping for those claims, since the model will regroup them together on the next run exactly as it did before; new ids for at least one side; and downstream repointing of `commitment.person_id`, `project/event.related_ids`, `insight.affected_entity_ids` and edge endpoints to whichever side each reference belongs to, which is itself a per-reference judgement the current repoint code cannot make because it is a one-to-one map. The live cases needing it are documented: `Nate (friend)` absorbed into `Nate Tennant`, and `Brian Tennant` carrying a work colleague's claims.

## A9. Synthesis outputs

| Output | Computed where | Inputs | Persisted? |
|---|---|---|---|
| Insights | `runInsightsPass`, `derive.ts:398` | The whole canonical layer, 417 nodes and edges, 109,805 chars | Yes, `insights`, 73 live rows |
| Discrepancies | Model side output, collected by `paginatedCollect` into `discrepancyItems` | Per-pass claims | **No** |
| Open threads | Model side output | Per-pass claims | **No**, only counted |

**Discrepancies are consumed in-run and then discarded.** `paginatedCollect` parses them (`stage-common.ts:314`), `runDerivation` feeds them to `supersedeFromDiscrepancies` (`derive.ts:713`), and nothing writes them. Open threads are never even parsed into objects; `stage-common.ts:322` keeps only a count: `if (Array.isArray(out.open_threads)) openThreads += out.open_threads.length`.

**The discard point moved in migration 0022.** Discrepancy items previously survived on `miner_runs.summary`. `shapedSummary` in `run.ts` now strips `discrepancyItems` at persist time, keeping only the count, because the items carried model prose about real people and violated the shaped-column rule. That was the last place they existed after a run ended.

**The destination tables exist and are empty.** Live counts:

- `discrepancies`: **0 rows**. Columns `id, user_id, data, resolved, created_at`.
- `open_threads`: **0 rows**. Columns `id, user_id, data, status, created_at`.
- `collection_items`: **0 rows**. `collections`: **0 rows**.

No reader exists for any of them. Both `discrepancies` and `open_threads` were created in migration 0006 and have never been written to.

## A10. Cost and time attribution

`usage_ledger` does not exist. All figures from `telemetry_events` where `event_type = 'llm_call'`, 32 rows across the two runs. Rates for `claude-opus-4-8`: input $5/MTok, output $25/MTok, cache write $6.25/MTok, cache read $0.50/MTok.

| | calls | input | output | cache read | cache write | model time | cost |
|---|---|---|---|---|---|---|---|
| run 8 | 20 | 286,341 | 189,390 | 10,184 | 7,902 | 36.9 min | **$6.22** |
| run 9 | 12 | 217,259 | 146,031 | 6,693 | 6,871 | 29.6 min | **$4.78** |
| both | 32 | 503,600 | 335,421 | 16,877 | 14,773 | | **$11.00** |

Per pass, run 8:

| Pass | calls | input tokens | context share of input | context tokens | pass cost |
|---|---|---|---|---|---|
| canonical_people | 5 | 66,324 | 0% | 0 | $1.513 |
| canonical_places_orgs | 3 | 25,236 | 0% | 0 | $0.808 |
| canonical_projects | 1 | 11,575 | 75% | 8,681 | $0.242 |
| canonical_events | 2 | 28,842 | 60% | 17,305 | $0.880 |
| canonical_facts | 4 | 30,545 | 0% | 0 | $0.635 |
| canonical_relationships | 2 | 55,823 | 78% | 43,542 | $1.126 |
| canonical_commitments | 2 | 25,330 | 70% | 17,731 | $0.527 |
| insights | 1 | 42,666 | 100% | 42,666 | $0.488 |

**Cost attribution for run 8, by payload section:**

- Output tokens: $4.735, **76.1% of the run**
- Input tokens: $1.432, 23.0%, of which:
  - canonical context: 129,925 of 286,341 input tokens, 45.4% of input, **$0.650, 10.4% of the run**
  - claims and scaffolding: $0.782, 12.6% of the run
- System prompt, cached: $0.054, **0.9% of the run**

**The single most important cost fact in this document: on a full recompute, removing all canonical context from every payload would save at most 10.4 percent of the run, because output tokens are 76 percent of the cost.** The system prompt, the thing prompt caching optimizes, is under one percent.

The incremental path inverts this. Folding one capture ships roughly 74,850 input tokens of which 92 to 98 percent is context, and produces very little output, so context is the dominant cost there.

**Prompt caching is working and nearly irrelevant.** 16,877 cached reads saved $0.076; 14,773 cache writes cost $0.018 extra at the 1.25x premium; net saving $0.058 across both runs, 0.5 percent. The cached system block is 1,031 to 1,429 tokens depending on pass, against Opus 4.8's 1,024 token cacheable minimum. The `canonical_places_orgs` block clears the minimum by **7 tokens**, so a small prompt edit would silently stop it caching.

**Reliability.** All 32 calls returned `stop_reason: end_turn`. Zero non-ok outcomes, zero attempts past 1, zero rejected claim ids.

---

# Part B: the Miine reference miner

Read from `reference/context-miner-updated-reference`. `reference/.../miner-core/src` is 5,726 lines across 13 files, against Memo's 21 files.

**Topology.** Runs are consumed from a queue rather than triggered: `reference/.../miner-core/src/run.ts:107-113` scans `mining_runs` for `status = 'queued'`, and `claimRun` (`reference/.../miner-core/src/run.ts:120`) claims it with a `.eq('status','queued')` guard so a double claim is a no-op. Stages are A (people, entities), B (processes, responsibilities), C (relationships, insights), Knowledge (tribal knowledge, decisions), Summaries.

**Data model.** Tenancy key is `company_id`, not `user_id`. Raw tables per claim type, canonical tables per entity type, plus `*_history` archive tables written by an `archive_canonical_row` trigger. Rounds are a first-class concept: rows carry `first_seen_round` and `last_updated_round`, and `reference/.../miner-core/src/run.ts:156-189` stamps each run with the max `sessions.round_number`.

**Identity: no content derivation at all.** `reference/.../miner-core/src/stage-common.ts:879`:

```ts
      id: matchedId[i] ?? randomUUID(),
```

Every id is random. Continuity comes entirely from matching forward, never from hashing content. This is the opposite of Memo's 64 percent content-derived scheme.

**B3. How Miine resolves a claim to an existing entity, and whether the model participates.**

The model does **not** participate in identity. Resolution is a deterministic three-tier code ladder in `writeCanonicalSet`, against all live rows for the company.

Tier 1, exact primary identity, one-to-one (`reference/.../miner-core/src/stage-common.ts:794-802`):

```ts
  newRows.forEach((_, i) => {
    const want = newIdents[i].primary;
    if (!want) return;
    const m = existing.find((e) => !used.has(e.id) && e.ident.primary === want);
    if (m) {
      matchedId[i] = m.id;
      used.add(m.id);
    }
  });
```

Tier 2, alias overlap (`reference/.../miner-core/src/stage-common.ts:803-813`), same shape, matching if any alias is shared.

Tier 3, **claim-overlap fallback**, restricted to five churn-prone tables (`reference/.../miner-core/src/stage-common.ts:727-736`: `canonical_responsibilities`, `canonical_processes`, `insights`, `canonical_tribal_knowledge`, `canonical_decisions`). It matches on provenance rather than on text (`reference/.../miner-core/src/stage-common.ts:744-749`):

```ts
function claimOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}
```

Threshold is `score <= 0.5` rejected. Ties break on the most recent `last_updated_round`, and a remaining tie stays unmatched. The comment states the safety posture explicitly: "an insert+retire is safer than a wrong merge". Assignment is one-to-one in both directions.

Tier 4, mint a random uuid.

The prompts reinforce the separation. From `reference/.../miner-core/src/stage-knowledge-prompts.generated.ts:7`, canonical nodes are given "ONLY to name holders and topics", and "**these are node ids, NOT provenance**, and you reference them BY NAME (see below), never by id". Memo does the opposite: its model emits canonical uuids directly into `related_ids` and into edge `source_id` / `target_id`.

**B4. No incremental path. Every pass is single-shot per corpus.**

`reference/.../miner-core/src/stage-c.ts:16`: "Both passes are single-shot (one LLM call each". `reference/.../miner-core/src/stage-common.ts:240`: "PR5 deleted the old multi-batch / has_more loop: post PR3+4 every pass is a" single call. A `has_more: true` response is now treated as an **error** signalling model truncation (`reference/.../miner-core/src/stage-common.ts:393-404`), not as a pagination signal.

Grepping `reference/.../miner-core/src` for `inputHash`, `input_hash`, `miner_state`, `incorporated` and `memo` returns no memoization mechanism of any kind. There are no incorporated markers, no per-pass input hash, and no "new since last run" concept.

**B1. Miine performs a full recompute on every run, and the trigger is a queued row.** Rounds do not make it incremental. A round is a batch of interviews that adds claims; the next run then re-derives the entire canonical set from all claims across all rounds. `first_seen_round` and `last_updated_round` are provenance metadata and a tie-breaker, not a scoping filter.

**B2. Miine sends the whole canonical layer**, same as Memo. `NODES_JSON` is populated from `nodesForPrompt` at `reference/.../miner-core/src/stage-c.ts:149`, `reference/.../miner-core/src/stage-knowledge.ts:195` and `reference/.../miner-core/src/stage-knowledge.ts:353`, with no retrieval or ranking step anywhere in the file set. The divergence is not in how much context is sent; it is in what the model is permitted to do with it.

**B7. Write semantics: Miine retires unconditionally.** `reference/.../miner-core/src/stage-common.ts:870`:

```ts
  const retiredIds = existing.filter((e) => !used.has(e.id)).map((e) => e.id);
```

Every existing row not matched by the ladder is retired: stamped with `valid_to` and then **deleted**, with both states archived by the trigger. There is no absorbed-evidence test and no safety cap. The comment marks it "destructive-allowed: retire step of the id-preserving recompute (spec §3.8 LOCKED)".

**B8. No corrections mechanism.** No equivalent of `corrections`, `rename_person`, `merge_people` or `applyRenameLabels` exists.

**B9. Determinism: no.** All ids are random and matched forward, so the graph is entirely path-dependent, more so than Memo's.

**B5. Mechanisms each has that the other lacks.**

Miine has and Memo lacks:

1. A claim-overlap identity fallback on provenance rather than text, scoped to the tables that churn.
2. Unconditional retirement of unmatched rows, so the canonical set is exactly what the last run emitted.
3. One-to-one match assignment with explicit ambiguity abstention in both directions.
4. A rule that the model names entities by name and never by id.
5. `has_more` treated as a truncation alarm.

Memo has and Miine lacks:

1. Content-derived ids (`canonicalId`, `canonicalPersonId`).
2. An incremental path with incorporated markers and per-pass input-hash memoization.
3. A persisted alias table (`entity_aliases`, 686 live rows).
4. A corrections mechanism with two kinds and downstream repointing.
5. Output pagination with a batch loop that is still live.
6. A freshness loop with decay anchors, salience, and discrepancy-driven supersession.
7. A retirement safety cap.
8. Short claim handles in the payload.

**B6. Deliberate, drift, or accident of timing?** Mixed, and separable.

Deliberate: Miine's unconditional retirement is marked LOCKED against a spec section, and Memo's absorbed-evidence test plus cap was introduced by the 2026-07-01 audit as a specific response to duplication-immortality. Those are two considered answers to the same question.

Accident of timing: Miine deleted its batch loop in its PR5; Memo still has one and pages verbose tables at 15. Memo's handle scheme post-dates Miine entirely and Miine still asks for verbatim uuids.

Drift: the claim-overlap fallback is the clearest case. Miine identified label-churn on phrase-shaped tables and solved it with provenance matching. Memo has the identical problem in `canonical_facts` and `insights` and solved it with a text-similarity fuzzy tier that does not fire often enough, then added a cap to contain the consequences. Nothing records that either team knew about the other's approach.

---

# Part C: the proposed design, and where it is wrong

## C1. Element by element against what exists

| Proposed element | Status | Evidence |
|---|---|---|
| Filing separated from synthesis | **Partly exists.** Extraction is already separate, per-capture, and memoized. What is not separate is resolution, which happens inside the synthesis call. | `extract.ts`, `miner_state` scope `extract:` |
| Three-tier ladder, model last resort | **Exists, and the model is already not in the identity path.** `resolution.ts` runs exact, alias, fuzzy, mint, all in code. The model proposes labels; code decides ids. | `derive.ts:201-206` |
| Corrections as pure graph operations | **Partly exists.** `supersedeLosers`, `applyRenameLabels`, `retireStaleRelationships` and `repointReferences` are already pure graph operations with zero model calls. What is not pure is the trigger: a correction forces a full recompute. | `corrections.ts`, `incremental.ts:545` |
| Background reconciliation replacing recompute's corrective role | **Would need building.** No background reconciliation exists. `reconcileFreshness` updates decay anchors and salience only. | `freshness.ts` |
| Synthesis fed by candidates from filing | **Half exists and is thrown away.** See C5. | `stage-common.ts:314-322` |
| Full recompute behind consent plus `derivation_version` | **Would need building.** No such column exists and no consent gate exists. | schema |

The proposal's most confident claim, that the model should be the last resort in resolution, describes the system that already ships.

## C2. Which claim types are genuinely local

Per type, with the mechanism that decides it:

| Type | Local? | Why, with evidence |
|---|---|---|
| people | **Local** | Full pass already runs with `context: []` (`derive.ts:580`). It resolves from claims alone and then a code resolver. |
| places_orgs | **Local** | Same, `derive.ts:590`. |
| facts | **Local for filing, global for dedup** | Runs with `context: []` (`derive.ts:645`) yet 60% of live rows are minted ids and 57 rows qualified as absorbed duplicates. Filing works locally; deduplication does not. |
| projects | **Needs people and places** | `context: aNodes`, and `data.related_ids` references node ids. |
| events | **Needs people and places** | Same. |
| commitments | **Needs people** | Same, plus `data.person_id` drives the resolver context key. |
| relationships | **Global by construction** | Both endpoints must resolve to canonical node ids from the full node set (`derive.ts:658` passes `allNodes`), and the id is a hash of both endpoints (`derive.ts:346`). A relationship cannot be filed before its endpoints exist. |
| insights | **Global by definition** | The pass takes no claims at all, only `canonical_layer`. |

So of 8 types: 3 file locally, 3 need a resolved people-and-places layer but not their own history, 1 needs the entire node set, 1 is not a filing operation at all. **The proposal's implied "most things are local" is 3 of 8 unconditionally, 6 of 8 given a resolved person layer.**

## C3. What breaks if filing becomes local

Four things, concretely.

1. **Absorbed-row retirement stops being computable.** The test at `stage-common.ts:553` requires `attributed`, the union of claims cited by every row emitted **in that pass**. A per-claim filing operation never has that set. Retirement would need to be re-expressed as a background job over the whole table, which is a different algorithm, not a port.

2. **The retirement cap loses its denominator.** `Math.max(5, Math.floor(current.length * 0.5))` is a bound on a batch. There is no batch under local filing.

3. **Duplicate detection loses the model's global view for exactly the types that need it most.** Facts already file with empty context, so nothing is lost there. But the 57 absorbed fact rows were identified precisely because one pass saw all 133 fact claims at once and regrouped them into 53 nodes. A per-claim filer would file each claim against the resolver only, and the resolver's fuzzy tier at 0.8 demonstrably fails on phrase-shaped labels, which is why those rows exist.

4. **Relationships cannot be filed at all without an ordering guarantee.** Endpoint ids must exist first. This is a hard dependency, not a preference.

## C4. Candidate retrieval: trigram against embeddings against hybrid

**Live infrastructure state.** Both are available and neither is installed:

```
fuzzystrmatch   available=1.2    installed=NOT INSTALLED
pg_trgm         available=1.6    installed=NOT INSTALLED
vector          available=0.8.0  installed=NOT INSTALLED
```

**Scale context, which dominates this decision.** Largest canonical table is `canonical_facts` at 354 rows and 336 kB. The entire live canonical layer is 529 rows. `canonical_history` at 4,767 rows and 5.7 MB is the largest table in the schema.

| | Trigram (`pg_trgm`) | Embeddings (`pgvector`) | Hybrid |
|---|---|---|---|
| Infrastructure | One `CREATE EXTENSION`, one GIN index per searchable column | Extension, an embedding model choice, an API budget, a backfill job, a re-embed path on label change, an HNSW or IVFFlat index | Both |
| Per-row cost | Index write on insert or label update, negligible at 529 rows | One embedding call per row per label change, plus vector storage at 1,536 dims by 4 bytes, about 6 kB per row | Both |
| Per-claim cost | One SQL query, sub-millisecond | One embedding call for the query text, plus a vector search | One embedding call plus one SQL query |
| Quality: people, places | Good. Names are short and share character trigrams. Catches typos like `Sean Yonka` against `Sean Janka`. | Good but not better. Embeddings on short proper nouns are weak, and can pull semantically related but distinct people together. | Trigram is sufficient |
| Quality: facts, insights | **Poor.** `Loves surfing` against `First time surfing at Leo Carrillo` share trigrams without being the same fact; `Has been surfing since March 2020` against `Started surfing in early 2020` are the same fact with low trigram overlap. | **This is where embeddings earn their cost.** Paraphrase is the failure mode and semantic similarity is the matching notion. | The reason a hybrid exists |
| Quality: commitments | Mixed. The discriminator is often the linked person, not the text, which neither method addresses. | Same. | Same |
| Index maintenance | GIN index bloats on frequent updates, needs occasional REINDEX. Trivial at this scale. | Embeddings go stale on every label change. Needs a queue or a trigger. HNSW build is expensive to rebuild. | Both burdens |

**A fact this comparison must not omit:** at 529 rows, no index is needed for any of these. A sequential scan comparing a query label against 354 fact labels in Node takes microseconds, and `resolution.ts` already does exactly that in memory. The infrastructure question is entirely about a future graph size that is not yet measured, and **not determined** here is what that size will be. What would determine it: the capture rate. 41 captures produced 529 live canonical rows over roughly seven weeks.

**Third option, hybrid, stated concretely.** Trigram or in-memory token-Jaccard as a cheap recall filter to produce the top 20 to 50 candidates, then embeddings only over that shortlist for the phrase-shaped types. This bounds embedding cost to the types that need it and avoids embedding the whole graph. It also matches what Miine does structurally, since Miine applies its expensive claim-overlap tier only to five named churn-prone tables rather than universally.

Not picking one, as instructed. The evidence supports: trigram is sufficient and nearly free for people and places; embeddings are the only one of the three that addresses the actual fact-paraphrase failure; the hybrid is the only option whose cost scales with the problem rather than with the graph.

## C5. Synthesis candidates: how much already exists

**More than the proposal assumes, and it is discarded rather than absent.**

The model already emits discrepancies and open threads as side outputs on every pass. `paginatedCollect` already parses discrepancies into structured `DiscrepancyItem` objects and deduplicates them across batches by their conflicting claim set (`stage-common.ts:314`). They are already consumed for a real purpose, driving `supersedeFromDiscrepancies`.

What is missing is one insert. The `discrepancies` table exists with columns `id, user_id, data, resolved, created_at` and has **0 rows**. `open_threads` exists with `id, user_id, data, status, created_at` and has **0 rows**. Migration 0022 removed the last place discrepancy items survived a run.

**Cost at filing time: zero additional model tokens.** The model already produces both. The cost is one batched insert per pass, plus a shaping step, because these fields carry model prose about real people and would violate the shaped-column standing rule if written raw. That shaping requirement is the real work and it is not trivial: `data` is a jsonb column and a free-text `subject` and `description` are exactly what migration 0022 was written to remove from `miner_runs.summary`.

Open threads are cheaper and weaker: `stage-common.ts:322` keeps only `out.open_threads.length` and never parses the objects, so persisting them requires parsing that does not currently exist.

**The proposal is right that this is nearly free and wrong that it is new.** It is a discard, not a gap, and the reason for the discard is a privacy rule rather than an oversight.

## C6. Can labeled pairs be mined from history?

**Yes for positives, with caveats. Counts measured live.**

Positive pairs, meaning a row the system merged or retired onto a successor, from `superseded_by`:

| Table | retired | with `superseded_by` |
|---|---|---|
| canonical_relationships | 117 | 94 |
| canonical_facts | 66 | 62 |
| canonical_commitments | 57 | 56 |
| canonical_events | 43 | 43 |
| canonical_people | 27 | 27 |
| canonical_places_orgs | 11 | 11 |
| insights | 11 | 11 |
| canonical_projects | 1 | 1 |
| **total** | **333** | **305** |

**305 positive pairs.** Negatives are abundant: `canonical_people` alone yields 2,278 distinct live-live pairs that the system kept separate.

Three caveats that limit the value:

1. **The labels are the system's own decisions, not ground truth.** A pair merged by `retireAbsorbedRows` is labeled positive because the current algorithm merged it. Training or threshold-tuning against that reproduces the current behaviour, including its errors. The two known wrong merges, `Nate (friend)` into `Nate Tennant` and the Brian contamination, are in this positive set and are wrong.
2. **The classes are extremely unbalanced**, 305 against thousands, so a precision measurement needs stratified sampling rather than the raw pair set.
3. **Provenance of each label is mixed.** Some supersessions came from user corrections, which are genuine ground truth; some from `retireAbsorbedRows`, which is algorithmic; some from `supersedeFromDiscrepancies`, which is model-driven. The `corrections` table has 19 rows, so **only about 19 of the 305 positives are user-confirmed.**

**Verdict: the history supports a regression harness, not a ground-truth harness.** It can answer "does the new matcher agree with the old one" for 305 cases. It cannot give a measured precision against truth without human labeling, and the honest labeled-pair count for that purpose is 19, not 305.

## C7. Attacking the proposal

Seven objections, ordered by how much they threaten the design.

**1. The cost premise is wrong for the case the design optimizes.** The proposal implies payload reduction is the win. Measured: canonical context is **10.4 percent** of a full run's cost and output tokens are **76.1 percent**. Eliminating context entirely from a full recompute saves about 65 cents on a $6.22 run. The design's cost argument only holds on the incremental path, where context is 92 to 98 percent of the payload, and the incremental path is not what the proposal is replacing.

**2. Making the model the last resort describes the current system.** `derive.ts:201-206` already resolves in code with the model out of the identity path. If the resolver is producing 190 minted ids out of 529 rows, the failure is that its fuzzy tier is too tight for phrase-shaped labels, not that the model is involved. A three-tier ladder that is architecturally identical to the existing four-tier ladder will inherit the same miss rate.

**3. Background reconciliation moves cost rather than removing it, and adds a failure mode.** Every merge the recompute makes today is made with the model seeing all claims for a type at once. A background reconciler sees pairs. Pairwise merging without the global view is precisely the operation that produced the two known wrong merges, and there would be no human in the loop when it runs. The recompute is slow and expensive but it is also the current safety mechanism, because a bad merge shows up in one reviewable run rather than trickling in.

**4. Local filing removes the only mechanism that currently detects absorbed duplicates.** The 57 absorbed fact rows were found because one pass regrouped 133 claims at once. C3 covers this. The proposal replaces a working global detector with a resolver whose measured miss rate on that exact table is 60 percent.

**5. `derivation_version` plus consent-gated recompute makes the accumulation permanent.** Today facts accumulate because the cap refuses. Under the proposal, full recompute becomes rare by design. Whatever the reconciler fails to merge stays in the graph until a human consents to a recompute, and the read surfaces have no notion of a low-confidence row.

**6. The proposal has no answer for relationships, which are 75 live rows and 25 of the 75 inserts in run 9.** They are global by construction, endpoint-keyed, and 0 percent minted. They are the table that churns most and the one least amenable to local filing.

**7. Determinism is invoked as something to preserve, and it does not exist.** 35.9 percent of live rows carry a random id. Gating recompute to protect reproducibility protects a property the system lost long ago. This one cuts in the proposal's favour and is listed here because the design should stop paying for it.

**What the proposal gets right, stated plainly so the criticism is calibrated:** filing and synthesis genuinely are conflated today; corrections genuinely should not cost a full recompute, and the measured price of that conflation is a 30.9 minute $4.78 run triggered by one rename; and the synthesis-candidate idea is nearly free because the data is already computed and thrown away.

---

# Part D: three-way comparison

| Dimension | Memo today | Miine today | Proposed |
|---|---|---|---|
| Full recompute trigger | First run, or any new correction (`incremental.ts:545`) | Every run; a queued `mining_runs` row (`reference/.../miner-core/src/run.ts:107-113`) | Explicit user consent plus `derivation_version` |
| What the model sees per call | Full path: 0 to 342 context nodes depending on pass, 0% to 100% of payload. Incremental: whole layer, 92 to 98% of payload | Whole canonical layer, single shot, no pagination | Retrieved candidate subset |
| Entity resolution | Code ladder: exact, alias, fuzzy 0.8, context key, mint random. Model not in identity path | Code ladder: exact primary, alias overlap, claim overlap > 0.5 on 5 named tables, mint random. Model explicitly forbidden from emitting ids | Three-tier ladder, model last resort |
| Ids | 64.1% content-derived UUIDv5, 35.9% random | 100% random, matched forward | Not specified |
| Corrections | 2 kinds, pure graph ops, but trigger a full recompute | None | Pure graph ops, no recompute |
| Synthesis | Insights pass over the whole layer, 51,780 tokens. Discrepancies and open threads computed then discarded | Insights as a canonical table with claim-overlap matching. Discrepancies and open threads in prompts | Fed by candidates accumulated at filing |
| Duplicate detection | Model regroups all claims per pass, then absorbed-evidence test with a 50% cap | Unconditional retirement of every unmatched row | Background reconciliation with a confidence bar |
| Cost scaling with graph size | Full: output-dominated, 76%. Incremental: context-dominated, superlinear in graph size | Linear in total claims, every run | Intended sublinear |
| Deterministic output | **No.** 35.9% of ids path-dependent | **No.** All ids path-dependent | Not addressed |
| Incrementality | Markers plus per-pass input hash plus corrections fingerprint | **None** | Incremental-first |

## Should `miner-core` remain shared?

**They should diverge permanently, and the evidence is that they already have.**

The two miners share a silhouette and almost no mechanism. Miine has no corrections, no memoization, no incremental path, no content-derived ids, no pagination, no freshness loop, no safety cap, and no alias table. Memo has all seven. Miine has a claim-overlap matcher, unconditional retirement, and a by-name-only prompt contract, none of which Memo has. Counting mechanisms rather than intentions, the overlap is: raw claims to canonical rows, provenance as claim id arrays, a per-type pass structure, and side outputs named `discrepancies` and `open_threads`. That is a shared design pattern, which is already written down in `context-mining-pattern.md`, and a pattern is not a package.

The workload difference explains why the mechanisms diverged and predicts that they will keep diverging. Miine mines a bounded corpus that grows in discrete rounds and then stops, for a company that can tolerate a full recompute per round because the corpus has a ceiling. Unconditional retirement is safe there: if a row is not in the current worldview, the current worldview is right, and the round boundary is a natural consistency point. Memo mines a life, which has no ceiling and no rounds, where a fact from June must survive a run in December that never mentions it. That is exactly why Memo has an absorbed-evidence test and a cap where Miine has a delete, and it is not a difference that can be parameterised away, because it is a difference about whether absence of evidence is evidence of absence.

The honest position: keep `context-mining-pattern.md` as the shared artefact, let the code diverge, and treat cross-pollination as deliberate porting rather than shared maintenance. The one mechanism worth porting now is Miine's claim-overlap fallback, restricted the way Miine restricts it, because Memo's `canonical_facts` has precisely the churn problem that mechanism was built for, and Memo's answer to it is a cap that refuses.

---

# Part E: direct answers

**1. What does an incremental run send to the model, in nodes and tokens, per pass?**

The **entire current canonical layer for the type**, unbounded. Folding one capture: people 68 nodes / 3,219 tokens, places_orgs 85 / 4,221, facts 110 / 6,717, projects 180 / 11,116, events 205 / 11,703, commitments 192 / 11,473, relationships 342 / 26,401. Total about 74,850 input tokens across 7 passes, 92 to 98 percent of it context. No incremental insights pass exists. Evidence: `incremental.ts:600-684`, `readCanonicalNodes` at `stage-common.ts:91-100` with no LIMIT, and a payload reconstruction validating exactly against recorded `user_chars`.

**2. What fraction of claims resolve without any model involvement?**

**All of them, for identity.** The model never decides an id; it proposes labels and code resolves (`derive.ts:201-206`). The intended question, which tier of the ladder resolves them, is **not determined**: nothing records the tier, and none of the 21 `telemetry_events` event types is resolver-related. The one measurable proxy is the mint rate: 190 of 529 live rows, 35.9 percent, failed every tier and were assigned a random id. Instrumentation that would determine it: return a tier discriminator from `Resolver.resolve`, histogram it per pass, add five counts to the existing `miner_run` telemetry attrs.

**3. Which claim types are genuinely local?**

3 of 8 unconditionally: people, places_orgs, facts, all of which already run with `context: []`. 3 more given a resolved people-and-places layer: projects, events, commitments. 1 global by construction: relationships, whose id is a hash of both endpoint ids. 1 not a filing operation at all: insights, which takes no claims.

**4. Why does `applyRenameLabels` run after the people pass?**

Because it is a force-write that must beat `changeSignature`, which deliberately excludes the label (`stage-common.ts:386-388`), so a pure relabel is classified `unchanged` and never written. The call-site comment says so verbatim: "the change-signature excludes the label, so a pure relabel is otherwise skipped and the rename never lands" (`derive.ts:606-607`). It runs after because `resolveSurvivorIds` must read the rows the people pass just wrote, and before `aNodes` is read at `derive.ts:615` so stages B and C see the corrected label. Git history confirms it is a fix, not a design: `328ebeb fix(corrections): renames now land and clear pending on the next mine`.

**5. Trigram, embeddings, or hybrid, with real infrastructure costs?**

Not picking one, per instruction. Live state: `pg_trgm` 1.6 and `vector` 0.8.0 both available, neither installed. At the current 529 live canonical rows and 354-row largest table, **none is needed**; the in-memory scan in `resolution.ts` is already adequate and no index will pay for itself. Trigram is nearly free and sufficient for people and places. Embeddings are the only one of the three that addresses the measured failure, which is fact paraphrase, at a cost of an embedding per row per label change plus a re-embed path. The hybrid, cheap recall filter then embeddings over a shortlist for phrase-shaped types only, is the only option whose cost scales with the problem rather than the graph, and it mirrors Miine's restriction of its expensive tier to five named tables.

**6. Is the current graph reproducible from claims, or path-dependent?**

**Path-dependent, measurably.** 190 of 529 live rows, 35.9 percent, carry a resolver-minted random UUIDv4 that exists only because of the order past runs happened: commitments 87.2 percent, facts 60.0 percent, events 51.9 percent, people 17.6 percent, relationships 0 percent. Model non-determinism and batch-composition ordering add further variance on top. Reproducibility is not a property the current system has.

**7. Do Memo and Miine's miners diverge permanently?**

Yes. Counting mechanisms, Memo has 8 that Miine lacks and Miine has 5 that Memo lacks; the overlap is a design pattern, already written down in `context-mining-pattern.md`. The driver is structural rather than historical: Miine mines a bounded corpus in rounds and can safely delete any row not in the current worldview; Memo mines an unbounded life where absence of mention is not absence of fact. Keep the pattern document shared, let the code diverge, port deliberately. The one mechanism worth porting now is Miine's claim-overlap fallback (`reference/.../miner-core/src/stage-common.ts:744-749`), scoped as Miine scopes it.

**8. What does a `split_person` correction actually require?**

Not a label rewrite, which is what both existing kinds are. It requires: a payload carrying a claim-level partition of one row's `source_claim_ids` rather than two labels; a branch in derivation that **overrides the model's grouping** for those claims, because the model will regroup them identically on the next run; id assignment for at least the new side; and downstream repointing of `commitment.person_id`, `project`/`event.related_ids`, `insight.affected_entity_ids`, and edge endpoints, where each reference must be assigned to one side of the split. That last step is the real blocker: `repointReferences` is a one-to-one map from loser to survivor and cannot express a one-to-two decision. Live cases needing it: `Nate (friend)` absorbed into `Nate Tennant`, and `Brian Tennant` carrying a work colleague's claims.

---

## What this audit did not look at

Stated so the denominator is honest.

- The app read surfaces (`lib/chat/retrieval.ts`, `lib/companion/*`, `lib/people.ts`) were not audited, only noted as canonical readers.
- The interview and capture surfaces were traced only as far as `writeCapture`.
- `confirmations` has no writer and no reader; its intended role was not investigated.
- Miine's `stage-summaries.ts` (380 lines), `compose-rounds.ts` (783 lines) and `summaries-dump.ts` (286 lines) were not read; they are outside the mining path this audit compares.
- Resolver tier distribution, per A3, is not determined by any evidence available.
- The future graph size that would justify a retrieval index, per C4, is not determined.
- The first draft of this document stated the capture-write path as `writeCapture` alone. That was an incomplete enumeration, corrected in A1 above after an adversarial pass over this audit. It is recorded rather than silently fixed because it is the same denominator failure the document is written to guard against.
- Cost attribution assumes the measured chars-per-token ratio holds within a pass across batches. It was validated on batch 1 of every pass in run 8, 8 of 8, and not on later batches.
