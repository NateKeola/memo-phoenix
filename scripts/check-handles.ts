// Pure checks for the short claim-handle scheme (no DB, no model). Handles replace
// 36-character raw uuids in the model payload and are translated back the instant
// the response is parsed, so nothing persists a handle and validateCited still sees
// real uuids. Run: npx tsx scripts/check-handles.ts
import { issueHandles, translateClaimHandles } from '../packages/miner-core/src/handles'
import { rejectedClaimId, classifyLlmError } from '../packages/miner-core/src/call-telemetry'

let pass = 0
let fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`
const CLAIMS = Array.from({ length: 200 }, (_, i) => uuid(i))
const h = issueHandles(CLAIMS)

console.log('== handle shape and issuance ==')
const all = CLAIMS.map((c) => h.handleFor(c))
check('one handle per claim', h.size === 200 && all.length === 200)
check('every handle is 4 chars', all.every((x) => x.length === 4), all.find((x) => x.length !== 4) ?? '')
const ALPHABET = /^[abcdefghijkmnpqrstuvwxyz23456789]{4}$/
check('every handle is from the sparse alphabet (no l, o, 0, 1)', all.every((x) => ALPHABET.test(x)))
check('handles are unique', new Set(all).size === 200)
check('handleFor is stable across calls', CLAIMS.every((c) => h.handleFor(c) === h.handleFor(c)))
check('round-trips to the real uuid', CLAIMS.every((c) => h.claimFor(h.handleFor(c)) === c))
check('an unissued handle returns null', h.claimFor('zzzz') === null || !all.includes('zzzz'))
check('a raw uuid is not a handle', h.claimFor(uuid(0)) === null)
check('case slips fold (alphabet is lowercase, so folding is injective)', h.claimFor(all[0].toUpperCase()) === CLAIMS[0])
// The property that rules out ordinals: a slipped character should MISS, not land
// on a neighbouring real claim. With 200 of 32^4 issued, a random 4-char token
// almost never resolves.
let hits = 0
for (let i = 0; i < 5000; i++) {
  const t = Array.from({ length: 4 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]).join('')
  if (h.claimFor(t) !== null) hits++
}
check('a random 4-char token almost never resolves (< 2% of 5000)', hits < 100, `${hits} hits`)

console.log('\n== strict translation (nodes / edges / insights) ==')
const nodes = { nodes: [{ name: 'A', source_claim_ids: [h.handleFor(CLAIMS[0]), h.handleFor(CLAIMS[1])] }] }
translateClaimHandles(nodes, h, 'nodes', 'ctx')
check('nodes.source_claim_ids become real uuids',
  JSON.stringify(nodes.nodes[0].source_claim_ids) === JSON.stringify([CLAIMS[0], CLAIMS[1]]))

const ins = { insights: [{ statement: 'x', supporting_claim_ids: [h.handleFor(CLAIMS[5])] }] }
translateClaimHandles(ins, h, 'insights', 'ctx')
check('insights.supporting_claim_ids become real uuids',
  JSON.stringify(ins.insights[0].supporting_claim_ids) === JSON.stringify([CLAIMS[5]]))

// THE CASE THE ABANDONED CONSUMPTION FILTER WOULD HAVE BROKEN: one claim cited by
// two different nodes. Live data shows this in 4 of 8 canonical tables (a claim
// naming two parents becomes two edges), so it must translate for BOTH.
const shared = {
  edges: [
    { source_id: 'node-a', target_id: 'node-b', source_claim_ids: [h.handleFor(CLAIMS[9])] },
    { source_id: 'node-a', target_id: 'node-c', source_claim_ids: [h.handleFor(CLAIMS[9])] },
  ],
}
translateClaimHandles(shared, h, 'edges', 'ctx')
check('one claim cited by two nodes translates for both',
  shared.edges[0].source_claim_ids[0] === CLAIMS[9] && shared.edges[1].source_claim_ids[0] === CLAIMS[9])
check('edges.source_id / target_id are canonical ids and are NOT translated',
  shared.edges[0].source_id === 'node-a' && shared.edges[0].target_id === 'node-b')

const affected = { insights: [{ supporting_claim_ids: [h.handleFor(CLAIMS[3])], affected_entity_ids: ['canonical-uuid-here'] }] }
translateClaimHandles(affected, h, 'insights', 'ctx')
check('insights.affected_entity_ids are canonical ids and are NOT translated',
  affected.insights[0].affected_entity_ids[0] === 'canonical-uuid-here')

console.log('\n== strict translation fails loudly on an unissued handle ==')
let thrown: unknown = null
try {
  translateClaimHandles({ nodes: [{ source_claim_ids: ['zzz9'] }] }, h, 'nodes', 'canonical_people batch 2')
} catch (e) { thrown = e }
const msg = thrown instanceof Error ? thrown.message : ''
check('an unissued handle throws', thrown instanceof Error)
check('the message reuses the cited-unknown-raw-id wording', /cited unknown raw id/.test(msg), msg)
check('the message names the pass and batch', /canonical_people batch 2/.test(msg), msg)
check('call-telemetry classifies it unknown_claim_id', classifyLlmError('validate', thrown) === 'unknown_claim_id')
check('rejectedClaimId captures the 4-char handle', rejectedClaimId(thrown) === 'zzz9', String(rejectedClaimId(thrown)))
check('rejectedClaimId still captures a raw uuid',
  rejectedClaimId(new Error(`[miner] x: cited unknown raw id ${uuid(7)} (provenance must reference real claims)`)) === uuid(7))
check('rejectedClaimId does not half-match a longer malformed token',
  rejectedClaimId(new Error('[miner] x: cited unknown raw id abcdefgh (provenance must reference real claims)')) === null)

console.log('\n== lenient side outputs (deliberate: reproduces today tolerant behaviour) ==')
const side: Record<string, unknown> = {
  nodes: [],
  discrepancies: [{ subject: 's', claim_ids: [h.handleFor(CLAIMS[1]), 'zzz9', h.handleFor(CLAIMS[2])] }],
  open_threads: [{ description: 'd', source_claim_id: h.handleFor(CLAIMS[4]) }, { description: 'e', source_claim_id: null }],
}
let sideThrew = false
try { translateClaimHandles(side, h, 'nodes', 'ctx') } catch { sideThrew = true }
check('an unmapped handle in discrepancies does NOT throw', !sideThrew)
const disc = (side.discrepancies as Array<{ claim_ids: string[] }>)[0]
check('discrepancies keep the mapped ids and drop the unmapped one',
  JSON.stringify(disc.claim_ids) === JSON.stringify([CLAIMS[1], CLAIMS[2]]), JSON.stringify(disc.claim_ids))
const threads = side.open_threads as Array<{ source_claim_id: string | null }>
check('open_threads translate a mapped id', threads[0].source_claim_id === CLAIMS[4])
check('open_threads keep an explicit null', threads[1].source_claim_id === null)

console.log('\n== shape tolerance (must not change parse behaviour) ==')
const odd: Record<string, unknown> = { nodes: [{ source_claim_ids: [42, null, h.handleFor(CLAIMS[0])] }] }
translateClaimHandles(odd, h, 'nodes', 'ctx')
const oddCited = (odd.nodes as Array<{ source_claim_ids: unknown[] }>)[0].source_claim_ids
check('non-string entries pass through untouched (uniqueStrings drops them downstream)',
  oddCited[0] === 42 && oddCited[1] === null && oddCited[2] === CLAIMS[0])
let emptyThrew = false
try {
  translateClaimHandles({}, h, 'nodes', 'ctx')
  translateClaimHandles({ nodes: 'not-an-array', discrepancies: 5, open_threads: null }, h, 'nodes', 'ctx')
} catch { emptyThrew = true }
check('a malformed or empty response does not throw at translation', !emptyThrew)

console.log('\n== independence between passes ==')
const h2 = issueHandles(CLAIMS)
check('a second pass mints a different handle set', CLAIMS.some((c) => h2.handleFor(c) !== h.handleFor(c)))
check("one pass cannot resolve another pass' handle for a different claim",
  CLAIMS.every((c) => { const r = h2.claimFor(h.handleFor(c)); return r === null || r === c }))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
