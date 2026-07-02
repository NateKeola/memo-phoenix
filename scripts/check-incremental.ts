// Incremental miner: deterministic equivalence + idempotency tests for the merge
// math (no DB, no model, so it runs anywhere and is not subject to LLM variance).
//
// The full recompute is itself non-deterministic (the LLM rewords summaries and can
// group entities differently run to run), so byte-equality between two graphs is
// impossible even full-vs-full. The deterministic, checkable invariant is the MERGE:
// given the SAME model output, folding captures in batches through the incremental
// merge must produce the SAME canonical provenance as writing them all at once. This
// is exactly where a merge bug would live (dropping or double-counting claims), so it
// is the real acceptance gate. The live structural equivalence (real LLM) is the
// operator's cutover gate, documented in docs/incremental-miner.md.
//
// Run: npx tsx scripts/check-incremental.ts
import { mergeEmitted } from '../packages/miner-core/src/incremental'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${detail}`)
  }
}

type Emit = {
  id: string
  user_id: string
  label: string
  data: Record<string, unknown>
  source_claim_ids: string[]
  temporality: 'evergreen' | 'dated' | 'decaying'
  confidence: number
  salience: number
  summary: string | null
}
type Stored = Emit
type Current = { label: string | null; data: Record<string, unknown>; source_claim_ids: string[]; temporality: Emit['temporality']; confidence: number; summary: string | null }

function emit(id: string, claims: string[], opts: Partial<Emit> = {}): Emit {
  return {
    id,
    user_id: 'u',
    label: opts.label ?? id,
    data: opts.data ?? {},
    source_claim_ids: claims,
    temporality: opts.temporality ?? 'evergreen',
    confidence: opts.confidence ?? 0.7,
    salience: opts.salience ?? 0.3,
    summary: opts.summary ?? null,
  }
}

const toCurrent = (s: Stored): Current => ({
  label: (s as { label?: string | null }).label ?? null,
  data: s.data,
  source_claim_ids: s.source_claim_ids,
  temporality: s.temporality,
  confidence: s.confidence,
  summary: s.summary,
})

// Simulate writeCanonical's upsert (onConflict:id replaces the row).
function applyToStore(store: Map<string, Stored>, rows: Emit[]): void {
  for (const r of rows) store.set(r.id, r)
}

// The INCREMENTAL run: fold each batch into the accumulating store, merging against
// the current rows for the ids the batch touches (exactly what incNodePass does).
function runIncremental(batches: Emit[][]): Map<string, Stored> {
  const store = new Map<string, Stored>()
  for (const batch of batches) {
    const current = new Map<string, Current>()
    for (const r of batch) if (store.has(r.id)) current.set(r.id, toCurrent(store.get(r.id)!))
    const merged = mergeEmitted(batch, current)
    applyToStore(store, merged)
  }
  return store
}

// The FULL run: one pass over the same emissions, collapsing same-id by union (the
// derive.ts byId collapse). Flattened in the SAME order, so last-write-wins on data
// matches incremental.
function runFull(batches: Emit[][]): Map<string, Stored> {
  const byId = new Map<string, Stored>()
  for (const r of batches.flat()) {
    const ex = byId.get(r.id)
    if (!ex) {
      byId.set(r.id, { ...r, source_claim_ids: [...new Set(r.source_claim_ids)] })
      continue
    }
    ex.source_claim_ids = [...new Set([...ex.source_claim_ids, ...r.source_claim_ids])]
    ex.data = { ...ex.data, ...r.data }
    ex.temporality = r.temporality
    ex.confidence = r.confidence
    ex.summary = r.summary ?? ex.summary
    ex.label = r.label
  }
  return byId
}

const claimsOf = (store: Map<string, Stored>, id: string) => [...(store.get(id)?.source_claim_ids ?? [])].sort()
const idSet = (store: Map<string, Stored>) => [...store.keys()].sort().join(',')
const sameClaims = (a: Map<string, Stored>, b: Map<string, Stored>) => {
  if (idSet(a) !== idSet(b)) return false
  for (const id of a.keys()) {
    if (JSON.stringify(claimsOf(a, id)) !== JSON.stringify(claimsOf(b, id))) return false
  }
  return true
}

console.log('== mergeEmitted unit behaviour ==')
{
  // a brand-new entity (no current) passes through unchanged
  const merged = mergeEmitted([emit('p1', ['c1', 'c2'])], new Map())
  check('new entity inserted with its claims', merged.length === 1 && JSON.stringify(merged[0].source_claim_ids) === JSON.stringify(['c1', 'c2']))
}
{
  // a touched entity UNIONS the new claims into the existing provenance
  const current = new Map<string, Current>([
    ['p1', { label: null, data: { aliases: ['Bob'] }, source_claim_ids: ['c1', 'c2'], temporality: 'evergreen', confidence: 0.7, summary: 'old' }],
  ])
  const merged = mergeEmitted([emit('p1', ['c2', 'c3'], { data: { aliases: ['Bobby'] }, summary: 'new' })], current)
  const r = merged[0]
  check('touched entity unions provenance (no duplicate c2)', JSON.stringify([...r.source_claim_ids].sort()) === JSON.stringify(['c1', 'c2', 'c3']))
  check('touched entity unions aliases', JSON.stringify((r.data.aliases as string[]).slice().sort()) === JSON.stringify(['Bob', 'Bobby']))
  check('touched entity takes the refreshed summary', r.summary === 'new')
}
{
  // a plain re-emit of the SAME claims does not grow provenance (idempotent union)
  const current = new Map<string, Current>([
    ['p1', { label: null, data: {}, source_claim_ids: ['c1', 'c2'], temporality: 'evergreen', confidence: 0.7, summary: 's' }],
  ])
  const merged = mergeEmitted([emit('p1', ['c1', 'c2'])], current)
  check('re-emit of same claims => no growth', JSON.stringify([...merged[0].source_claim_ids].sort()) === JSON.stringify(['c1', 'c2']))
}

console.log('\n== batch-vs-full equivalence (the core theorem) ==')
{
  // Three captures arriving in three batches. p1 is touched in batch 1 and 3; p2 new
  // in batch 1; p3 new in batch 2. Incremental (batched) must equal full (all-at-once)
  // on the id set and per-id provenance union.
  const batches: Emit[][] = [
    [emit('p1', ['c1']), emit('p2', ['c2'])],
    [emit('p1', ['c3']), emit('p3', ['c4'])],
    [emit('p1', ['c5']), emit('p3', ['c6'])],
  ]
  const inc = runIncremental(batches)
  const full = runFull(batches)
  check('incremental id set == full id set', idSet(inc) === idSet(full), `${idSet(inc)} vs ${idSet(full)}`)
  check('incremental provenance == full provenance', sameClaims(inc, full))
  check('p1 accumulated all three of its claims', JSON.stringify(claimsOf(inc, 'p1')) === JSON.stringify(['c1', 'c3', 'c5']))
  check('p3 accumulated both its claims', JSON.stringify(claimsOf(inc, 'p3')) === JSON.stringify(['c4', 'c6']))
}
{
  // Coverage: every emitted claim ends up cited by exactly the entity that emitted it.
  const batches: Emit[][] = [
    [emit('a', ['x1', 'x2'])],
    [emit('b', ['x3']), emit('a', ['x4'])],
  ]
  const inc = runIncremental(batches)
  const allClaims = new Set<string>()
  for (const s of inc.values()) for (const c of s.source_claim_ids) allClaims.add(c)
  check('claim coverage: every claim incorporated', ['x1', 'x2', 'x3', 'x4'].every((c) => allClaims.has(c)))
}

console.log('\n== idempotency (re-run with no new captures changes nothing) ==')
{
  const batches: Emit[][] = [
    [emit('p1', ['c1']), emit('p2', ['c2'])],
    [emit('p1', ['c3'])],
  ]
  const store = runIncremental(batches)
  const before = JSON.stringify([...store.keys()].sort().map((id) => [id, claimsOf(store, id)]))
  // Re-run the LAST batch against the settled store (the same capture reprocessed).
  const current = new Map<string, Current>()
  for (const r of batches[1]) if (store.has(r.id)) current.set(r.id, toCurrent(store.get(r.id)!))
  const merged = mergeEmitted(batches[1], current)
  applyToStore(store, merged)
  const after = JSON.stringify([...store.keys()].sort().map((id) => [id, claimsOf(store, id)]))
  check('reprocessing a capture does not change provenance', before === after)
  check('reprocessing does not grow p1 claims', JSON.stringify(claimsOf(store, 'p1')) === JSON.stringify(['c1', 'c3']))
}

console.log('\n== order independence (different batch orders, same union) ==')
{
  const a = runIncremental([[emit('n', ['c1'])], [emit('n', ['c2'])], [emit('n', ['c3'])]])
  const b = runIncremental([[emit('n', ['c3'])], [emit('n', ['c1'])], [emit('n', ['c2'])]])
  check('claim union is order-independent', JSON.stringify(claimsOf(a, 'n')) === JSON.stringify(claimsOf(b, 'n')))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
