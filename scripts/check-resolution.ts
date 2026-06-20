// Deterministic-id hardening: pure tests for the resolution layer. No DB, no model,
// so it runs under the Anthropic usage limit. Covers the four-tier ladder (exact,
// alias, correction, fuzzy), the two failure modes the PR flags (too-loose wrongly
// merging distinct entities; too-tight missing a drifted label), context-key
// disambiguation, ambiguity safety, mint-on-no-match, and the Resolver's alias
// accumulation across a drift.
//
// Run: npx tsx scripts/check-resolution.ts
import {
  resolveId,
  Resolver,
  tokens,
  jaccard,
  type ResolveCandidate,
} from '../packages/miner-core/src/resolution'

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

const m = (pairs: Array<[string, string]>) => new Map(pairs)

console.log('== tokenization + jaccard ==')
check('tokens splits + normalizes', [...tokens('Call Alice Today!')].sort().join(',') === 'alice,call,today')
check('jaccard identical = 1', jaccard(tokens('kara lee'), tokens('Kara  Lee')) === 1)
check('jaccard disjoint = 0', jaccard(tokens('alice'), tokens('bob')) === 0)

console.log('\n== exact match preserves the existing id (unchanged label) ==')
{
  const cands: ResolveCandidate[] = [{ id: 'P1', label: 'Kara Lee', aliases: [] }]
  const r = resolveId({ labelNorm: 'kara lee', aliasNorms: [], candidates: cands, aliasMap: m([]) })
  check('exact -> existing id', r.id === 'P1' && r.via === 'exact')
}

console.log('\n== alias map (persisted drift / correction) resolves to the stable id ==')
{
  const cands: ResolveCandidate[] = [{ id: 'P1', label: 'Kara Lee', aliases: [] }]
  // a prior drift / correction recorded Karalea -> P1
  const am = m([['karalea', 'P1']])
  const r = resolveId({ labelNorm: 'karalea', aliasNorms: [], candidates: cands, aliasMap: am })
  check('alias map -> survivor id', r.id === 'P1' && r.via === 'alias')
}
{
  // candidate carries the alias in its own alias list
  const cands: ResolveCandidate[] = [{ id: 'P1', label: 'Kara Lee', aliases: ['Karalea'] }]
  const r = resolveId({ labelNorm: 'karalea', aliasNorms: [], candidates: cands, aliasMap: m([]) })
  check('candidate own-alias -> id', r.id === 'P1' && r.via === 'alias')
}
{
  // an emitted alias on the incoming node names an existing row
  const cands: ResolveCandidate[] = [{ id: 'P1', label: 'Kara Lee', aliases: [] }]
  const r = resolveId({ labelNorm: 'kara', aliasNorms: ['kara lee'], candidates: cands, aliasMap: m([]) })
  check('emitted alias names a current row -> id', r.id === 'P1' && r.via === 'alias')
}

console.log('\n== alias map must NOT resurrect a superseded / absent id ==')
{
  // map says karalea -> P_OLD, but P_OLD is not a current candidate (it was retired)
  const cands: ResolveCandidate[] = [{ id: 'P1', label: 'Kara Lee', aliases: [] }]
  const r = resolveId({ labelNorm: 'karalea', aliasNorms: [], candidates: cands, aliasMap: m([['karalea', 'P_OLD']]) })
  check('absent mapped id is not returned (mints instead)', r.id === null && r.via === 'mint')
}

console.log('\n== fuzzy: a reworded long phrase (fact/insight drift) resolves to the same id ==')
{
  const cands: ResolveCandidate[] = [
    { id: 'F1', label: 'Cole and Kara Lee have a dog named Sukah', aliases: [] },
  ]
  const r = resolveId({
    labelNorm: 'cole and kara lee have a dog called sukah',
    aliasNorms: [],
    candidates: cands,
    aliasMap: m([]),
  })
  check('long-phrase drift -> same id (fuzzy)', r.id === 'F1' && r.via === 'fuzzy')
}

console.log('\n== fuzzy is conservative: two distinct similar names are NOT merged ==')
{
  const cands: ResolveCandidate[] = [{ id: 'P1', label: 'John Smith', aliases: [] }]
  const r = resolveId({ labelNorm: 'john smyth', aliasNorms: [], candidates: cands, aliasMap: m([]) })
  check('John Smyth NOT merged into John Smith', r.id === null && r.via === 'mint', `got ${r.id}/${r.via}`)
}
{
  // two genuinely different facts that share a couple of words do not merge
  const cands: ResolveCandidate[] = [{ id: 'F1', label: 'Alice likes coffee', aliases: [] }]
  const r = resolveId({ labelNorm: 'alice likes tea', aliasNorms: [], candidates: cands, aliasMap: m([]) })
  check('different fact NOT merged (low overlap)', r.id === null && r.via === 'mint', `got ${r.id}/${r.via}`)
}

console.log('\n== context key (commitment linked person) ==')
{
  // same person + decent overlap -> relaxed threshold merges the drifted commitment
  const cands: ResolveCandidate[] = [{ id: 'C1', label: 'call Alice about the deck', aliases: [], contextKey: 'PA' }]
  const r = resolveId({
    labelNorm: 'contact alice about the deck',
    aliasNorms: [],
    candidates: cands,
    aliasMap: m([]),
    contextKey: 'PA',
  })
  check('same-person commitment drift -> same id (context fuzzy)', r.id === 'C1' && r.via === 'fuzzy', `got ${r.id}/${r.via}`)
}
{
  // disagreeing person is a hard NO even with high label overlap
  const cands: ResolveCandidate[] = [{ id: 'C1', label: 'call Alice about the deck', aliases: [], contextKey: 'PA' }]
  const r = resolveId({
    labelNorm: 'call alice about the deck',
    aliasNorms: [],
    candidates: cands,
    aliasMap: m([]),
    contextKey: 'PB',
  })
  check('disagreeing person is a hard no (mints)', r.id === null && r.via === 'mint', `got ${r.id}/${r.via}`)
}

console.log('\n== ambiguity guard: two near-tied candidates ABOVE threshold do not merge ==')
{
  // both candidates score exactly 0.8 (4 shared of 5 union) vs the incoming, a tie,
  // so the margin guard refuses to merge rather than guess.
  const cands: ResolveCandidate[] = [
    { id: 'X1', label: 'alpha beta gamma delta epsilon', aliases: [] },
    { id: 'X2', label: 'alpha beta gamma delta zeta', aliases: [] },
  ]
  const r = resolveId({ labelNorm: 'alpha beta gamma delta', aliasNorms: [], candidates: cands, aliasMap: m([]) })
  check('near-tied above-threshold candidates -> no merge (mint)', r.id === null && r.via === 'mint', `got ${r.id}/${r.via}`)
}

console.log('\n== Resolver: minting, in-run collapse, and alias accumulation across drift ==')
{
  let n = 0
  const mint = () => `NEW${++n}`
  const resolver = new Resolver({ candidates: [{ id: 'P1', label: 'Kara Lee', aliases: [] }], aliasMap: m([]), mint })

  const a = resolver.resolve('Kara Lee')
  check('existing resolved by exact, not new', a.id === 'P1' && !a.isNew)

  const b = resolver.resolve('Brand New Person')
  check('unknown mints a new id', b.id === 'NEW1' && b.isNew)

  const c = resolver.resolve('brand new person')
  check('same new thing re-mentioned this run collapses', c.id === 'NEW1' && !c.isNew)

  // a drift of the existing person: a reworded/aliased reference resolves to P1 and
  // the new surface form is remembered as an alias to persist
  const d = resolver.resolve('Kara', ['Kara Lee'])
  check('aliased reference resolves to existing id', d.id === 'P1')
  const persisted = resolver.newAliases()
  check('new aliases include the minted person label', persisted.some((x) => x.alias_norm === 'brand new person' && x.stable_id === 'NEW1'))
  check('new aliases include the drifted surface form -> P1', persisted.some((x) => x.alias_norm === 'kara' && x.stable_id === 'P1'))
}

console.log('\n== id preservation: an unchanged corpus resolves every node to its existing id ==')
{
  const existing: ResolveCandidate[] = [
    { id: 'P1', label: 'Kara Lee', aliases: [] },
    { id: 'F1', label: 'Alice likes coffee', aliases: [] },
    { id: 'PR1', label: 'the client portal', aliases: [] },
  ]
  // steady state: the alias map is already seeded (labels -> ids), so an unchanged
  // re-mine resolves every node by exact match and writes ZERO new alias rows.
  const seeded = m([
    ['kara lee', 'P1'],
    ['alice likes coffee', 'F1'],
    ['the client portal', 'PR1'],
  ])
  const resolver = new Resolver({ candidates: existing, aliasMap: seeded, mint: () => 'SHOULD_NOT_MINT' })
  const ids = existing.map((e) => resolver.resolve(e.label ?? '').id)
  check('every unchanged label keeps its id (no churn)', JSON.stringify(ids) === JSON.stringify(['P1', 'F1', 'PR1']))
  check('steady state writes zero new aliases (no churn)', resolver.newAliases().length === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
