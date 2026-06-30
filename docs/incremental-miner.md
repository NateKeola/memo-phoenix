# Incremental miner pass

The incremental mine processes only captures not yet incorporated into the current
canonical graph, instead of re-deriving the whole graph from every capture on every
run. It is gated behind `MINER_INCREMENTAL` (default OFF); OFF is byte-for-byte the
existing full recompute.

This document is the Phase 1 diagnostics and the Phase 2 design. The decision log in
`CLAUDE.md` has the dated summary.

## Phase 1 — Diagnostics (read from the code, not assumed)

The pipeline is `captures -> raw_* (extraction) -> canonical_* (derivation A/B/C) ->
freshness`. Source files in `packages/miner-core/src`.

### Where captures become raw claims, and how claims are keyed
- `extract.ts` `extractCapture(capture)` runs ONE extraction LLM call per capture and
  writes the emitted items into the 8 `raw_*` tables. Every raw row carries
  `capture_id` and `user_id`.
- Raw ids are deterministic: `rawId(userId, captureId, table, contentHash, occurrence)`
  (`identity.ts`), inserted `ON CONFLICT DO NOTHING`, so re-extraction is idempotent.
- Extraction is ALREADY per-capture incremental: a capture is extracted exactly once,
  tracked in `miner_state` under scope `extract:<captureId>` (`getState`/`setState`).
  `captures` is hard append-only, so the marker never lives on the capture row.
- **So the raw layer is already incremental. The cost and the non-incremental part is
  derivation.**

### How canonical rows aggregate claims, and which derived fields need the LLM
- A canonical row's provenance is `source_claim_ids uuid[]` (the raw claim ids the
  resolution model attributed to it). The shared block also has `temporality`,
  `confidence`, `salience`, `summary`, `valid_from/valid_to/superseded_by`,
  `last_confirmed_at` (migration 0004).
- Per node, the resolution model emits `name`, `summary`, `confidence`, `temporality`,
  `data`, and `source_claim_ids`. So **summary, confidence, temporality, label, and
  data wording are LLM-written per node** and require an LLM call to (re)produce.
- `salience` is NOT from the LLM. The node pass sets a provisional
  `salienceFrom(sourceCount)`, and then the freshness pass OVERWRITES it with a
  graph-based `computeSalience(...)` (`freshness.ts`). The final salience is a
  deterministic function of the graph structure.
- `last_confirmed_at` is deterministic: the newest supporting capture's date
  (`newestClaimMs`).
- **The memo is all-or-nothing at the table level.** `runNodePass` (`derive.ts`)
  computes `inputHash([table, ALL claims, context, correctionsFp, identityMode])`; if
  it matches `miner_state['derive:<table>']` the whole pass is skipped. Otherwise the
  model is fed ALL claims for the table and re-emits ALL nodes. So a single new claim
  busts the memo and forces a full re-derivation of that table. This is the ~22-minute
  cost; the memo only helps a true no-op second run.

### How entity ids are assigned (resolve against the existing graph)
- Default (OFF `MINER_STABLE_IDENTITY`): `id = canonicalId(userId, table, label)` =
  UUIDv5 of the normalized label; people use `canonicalPersonId(first, last)` which
  reconstructs the label. Deterministic, so the SAME label always yields the SAME id.
- ON: the `resolution.ts` ladder (exact -> alias -> fuzzy -> mint) against the current
  canonical rows + persisted `entity_aliases` (`resolve-store.ts buildResolver`).
- Either way, resolution is already "resolve an incoming entity against the existing
  graph." Incremental reuses the same path: in the default mode, a new claim about an
  existing entity computes the existing id and so merges; in stable mode the resolver
  matches it. Incremental mints a new id only for genuinely new entities.

### How edges and the freshness loop work; how retirement happens
- `runRelationshipsPass` feeds ALL `raw_relationships` claims + ALL resolved nodes to
  the model, which emits edges between resolved node ids; the edge id is
  `canonicalId(table, "source|target|relation")`. Edges whose endpoints are not in the
  node set are dropped (counted as open threads).
- `writeCanonical` is an id-preserving upsert that writes only rows whose
  change-signature `{sorted source_claim_ids, temporality}` changed, and it leaves a
  superseded (retired) row retired rather than resurrecting it.
- The freshness loop (`freshness.ts`, no LLM) runs last over the whole CURRENT layer:
  it maintains `last_confirmed_at` and graph-based `salience` (writing only diffs, so
  it is cheap), and it drives supersession from the discrepancies the model already
  flagged (`supersedeFromDiscrepancies` / `planSupersessions`, keyed on claim ids).
- **Stale-edge retirement is NOT driven by full re-derivation dropping edges.** Claims
  are append-only and immutable, so a full recompute re-emits every edge whose claim
  still exists; nothing is dropped. Retirement is supersession-driven (discrepancies +
  validity intervals) plus read-time decay. So incremental does not diverge from full
  on edge retirement: full does not retire by dropping either.

### How insights are derived
- `runInsightsPass` is GLOBAL: it feeds the WHOLE canonical layer (all nodes + all
  relationships with their summaries) to the model to find cross-corpus patterns, with
  the union of all `source_claim_ids` as the provenance pool.
- **Insights cannot be correctly updated from new captures alone**, because a new
  pattern can span entities derived from old captures. This is the one genuinely global
  pass.

### What state already tracks progress
- `miner_state(user_id, scope, input_hash)` (migration 0008), unique on
  `(user_id, scope)`. Scopes today: `extract:<captureId>` (per-capture extraction
  marker) and `derive:<table>` (per-table derivation memo). There is NO per-capture
  "incorporated into canonical" marker yet.

## Phase 2 — Design (confirmed against the code above)

### The per-capture processed marker (no migration)
A capture is "incorporated" once its claims have been folded into canonical. We track
it with a new `miner_state` scope `incorporated:<captureId>`, exactly the mechanism
extraction already uses for `extract:<captureId>`. This is a robust per-capture marker
(one row per capture, not a high-water timestamp), so backfilled or out-of-order
captures are handled. It needs NO migration: `miner_state` already exists and is the
designated home for per-capture "already processed" state, and adding scope rows is
additive by construction.

### The incremental mine
`mine()` still extracts every capture first (already per-capture incremental). Then it
branches: OFF -> `runDerivation` (the unchanged full recompute, which never touches the
`incorporated:` markers, so OFF is byte-identical); ON -> `runIncrementalDerivation`,
which decides:

1. Compute `unincorporated` = captures with no `incorporated:` marker, and the
   corrections fingerprint.
2. FULL when (a) no `incorporated:` marker exists yet (the first run after the flag is
   turned on: establish the baseline), or (b) the corrections fingerprint changed
   (rename/merge are inherently global). Run the existing `runDerivation`, then mark
   ALL extracted captures incorporated and record the corrections fingerprint. The
   full path is unchanged and stays long-running / offloaded (CLI, GitHub Action).
3. NO-OP when there are no unincorporated captures: run only the cheap freshness
   reconcile (diffs only) so anchors/salience stay current, change nothing else.
4. INCREMENTAL otherwise. For each table, take only the NEW claims (raw rows whose
   `capture_id` is unincorporated), feed them plus the existing canonical nodes as
   context to the model, resolve the emitted entities against the existing graph
   (reuse the active resolution path), and MERGE into canonical:
   - union the new `source_claim_ids` into the existing row's set (the critical step:
     a plain upsert would overwrite provenance),
   - merge `data` and union `aliases`,
   - take the model's refreshed `summary`/`temporality`/`confidence` for touched rows,
   - untouched entities and untouched captures are never re-derived or re-summarized.
   New entities are inserted. Then add/merge edges for the new relationship claims,
   run `supersedeFromDiscrepancies` over the new captures' discrepancies, and run
   `reconcileFreshness` (whole-layer, diffs only). Finally mark the processed captures
   incorporated. The marker advances ONLY on success.

Idempotency: reprocessing a capture is a no-op because `source_claim_ids` UNION rather
than duplicate, and the change-signature upsert writes nothing when nothing changed.

### Insights (OPEN-BLOCKING, decided)
Insights are global, so incremental does NOT refresh them. They are left to the full
rebuild (and a separate scheduled full pass). Incremental never silently produces wrong
insights; it simply does not touch the `insights` table. The periodic full rebuild
trues them up. Documented limitation.

### Stale-edge retirement / supersession (decided)
Full does not retire edges by dropping them (claims are append-only), so there is no
edge-retirement divergence. Supersession is driven by model discrepancies; incremental
applies it for the new captures' discrepancies (idempotent, claim-id-keyed) but cannot
flag a contradiction between two OLD claims it does not re-examine. That residue is
trued up by the periodic full rebuild, and read-time decay continues to age stale rows
regardless. Documented limitation.

### Wiring
Incremental is the default for in-app "Run now" and the daily cron once the flag is on
(it fits the 300s cap because the LLM only sees the new claims). The full recompute is
retained and is the path for corrections and an explicit manual "full rebuild" true-up
(CLI / Action, no timeout).

## Phase 4 — Verification strategy

The full recompute is itself NON-deterministic (the LLM rewords summaries, varies
confidence/temporality, and can label or group entities differently run to run). So
byte-equality between two graphs is impossible even full-vs-full. Equivalence is
therefore defined on the deterministic invariants and the merge math:

- **Deterministic merge equivalence (the runnable acceptance gate, no LLM):**
  `scripts/check-incremental.ts` proves that given identical model output, processing
  captures in batches through the incremental merge produces the SAME canonical state
  (ids, `source_claim_ids` unions, edges) as writing them all at once through the full
  path. This isolates and proves the merge correctness, which is where bugs live.
- **Idempotency:** re-running with no new captures changes nothing (union, not
  duplicate; change-signature upsert writes nothing).
- **Claim coverage:** after incremental, every processed capture's raw claims are cited
  by at least one current canonical row (no orphaned claim).
- **Live structural equivalence (operator cutover gate, real LLM):** on real data,
  incremental coverage is 100% and the node/edge/claim deltas vs a full recompute are
  within the full-vs-full noise floor; LLM-written fields (summary, confidence,
  temporality) are compared loosely because they vary between two full runs too. This
  is the gate before flipping `MINER_INCREMENTAL=1`, mirroring the `MINER_STABLE_IDENTITY`
  cutover.
- **Perf:** incremental makes LLM calls only for the tables the new captures touch, and
  each call's input is only the new claims, so a handful of new captures completes well
  under the 300s in-app cap and costs only the new-capture API calls.

### Verification results (this PR)
- Deterministic merge gate `scripts/check-incremental.ts`: 13/0. Proves batched
  incremental equals all-at-once full on the id set and the per-id provenance union,
  that re-emitting the same claims does not grow provenance (idempotent union), claim
  coverage, and order-independence.
- `tsc --noEmit` 0; `next build` 0 (miner-core is server-only, so the client bundle is
  unchanged at 102 kB shared First-Load JS; incremental internals and the service-role
  key are absent from `.next/static`).
- Guards green: `check-rls` 66/0, `check-multiuser` 47/0, `check-invite` 15/0,
  `check-miner-isolation` 33/0 (it imports the real `run.ts`/`incremental.ts` and proves
  the new code is user-scoped), `check-timing` 15/0. The modules incremental reuses also
  pass: `check-corrections` 20/0, `check-freshness` 34/0, `check-resolution` 22/0.
- OFF is unchanged: `MINER_INCREMENTAL` unset means `run.ts` calls `runDerivation`
  exactly as before; the incremental code path and the `incorporated:` markers are never
  touched.
- The live structural equivalence + a perf number are the operator's pre-flip gate (the
  flag stays OFF until then), mirroring the `MINER_STABLE_IDENTITY` cutover; running it
  on dev would mutate canonical and leave append-only capture residue, so it is left to
  the deliberate cutover rather than run here.

### A manual full rebuild (when the flag is globally on)
Run the CLI with the flag unset for that invocation: `MINER_INCREMENTAL=0 npm run miner`
(or unset it). That forces the full recompute path for a corrections true-up or a
periodic insight refresh, without changing the standing env.

## How to turn it on
1. Review this PR; keep `MINER_INCREMENTAL` unset (OFF) until the live equivalence gate
   passes on real data.
2. Run the live equivalence harness (a full recompute baseline, then the incremental
   path over the same captures, then the structural diff) and confirm coverage 100% and
   deltas within the full-vs-full envelope.
3. Set `MINER_INCREMENTAL=1` in the worker/Vercel env. The first run after that is a
   full baseline (it seeds the `incorporated:` markers); subsequent routine runs are
   incremental. The full rebuild remains available via the CLI for corrections and
   periodic true-up.
