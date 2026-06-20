// Deterministic-id hardening: pure tests for the data-migration PLANNER (no DB, no
// model). Verifies the alias-seed plan (labels + aliases + insight statements +
// corrections), pre-existing-duplicate collision/cluster detection, and that the
// plan is additive (every seeded alias points at an existing stable id, so nothing
// is orphaned).
//
// Run: node scripts/check-identity-migration.mjs
import { planSeedAliases, findDuplicateClusters, normLabel } from './migrate-identity.mjs'

let pass = 0
let fail = 0
const check = (n, c, d = '') => {
  if (c) {
    pass++
    console.log(`  ok   ${n}`)
  } else {
    fail++
    console.log(`  FAIL ${n} ${d}`)
  }
}

const U = '00000000-0000-0000-0000-000000000001'

const rowsByTable = {
  canonical_people: [
    { id: 'P1', user_id: U, label: 'Kara Lee', data: { aliases: ['Karalea'] } },
    { id: 'P2', user_id: U, label: 'Cole', data: {} },
  ],
  canonical_places_orgs: [],
  canonical_projects: [{ id: 'PR1', user_id: U, label: 'the client portal', data: {} }],
  canonical_events: [],
  canonical_facts: [
    { id: 'F1', user_id: U, label: 'Cole and Kara Lee have a dog named Sukah', data: {} },
    // a pre-existing duplicate from past drift (one word reworded)
    { id: 'F2', user_id: U, label: 'Cole and Kara Lee have a dog called Sukah', data: {} },
  ],
  canonical_commitments: [{ id: 'C1', user_id: U, label: 'call Alice about the deck', data: { person_id: 'PA' } }],
  insights: [{ id: 'I1', user_id: U, label: 'pattern', data: { statement: 'You reconnect with people when stressed' } }],
}

const corrections = [
  { user_id: U, kind: 'rename_person', payload: { from_label: 'Tal', to_label: 'Cole' } },
]

console.log('== seed plan: label + aliases + insight statement + correction ==')
const { aliasRows, collisions, counts } = planSeedAliases(rowsByTable, corrections)

const has = (table, alias, id, source) =>
  aliasRows.some(
    (a) => a.entity_table === table && a.alias_norm === normLabel(alias) && a.stable_id === id && (!source || a.source === source)
  )

check('seeds the person label -> id', has('canonical_people', 'Kara Lee', 'P1', 'seed'))
check('seeds the stored alias Karalea -> id', has('canonical_people', 'Karalea', 'P1', 'seed'))
check('seeds the project label -> id', has('canonical_projects', 'the client portal', 'PR1', 'seed'))
check('seeds the insight STATEMENT (not pattern_type) -> id', has('insights', 'You reconnect with people when stressed', 'I1', 'seed'))
check('does NOT seed the insight pattern_type label', !aliasRows.some((a) => a.entity_table === 'insights' && a.alias_norm === 'pattern'))
check('correction from-label Tal -> survivor Cole id (P2)', has('canonical_people', 'Tal', 'P2', 'correction'))
check('per-table counts present', (counts.canonical_people ?? 0) >= 2)

console.log('\n== additive + no orphans: every seeded alias points at an existing row id ==')
{
  const validIds = new Set()
  for (const t of Object.keys(rowsByTable)) for (const r of rowsByTable[t]) validIds.add(r.id)
  check('all seeded stable_ids are real current rows', aliasRows.every((a) => validIds.has(a.stable_id)))
}

console.log('\n== collisions: two current rows sharing a normalized label are flagged, not double-seeded ==')
{
  const dup = {
    canonical_facts: [
      { id: 'FA', user_id: U, label: 'likes coffee', data: {} },
      { id: 'FB', user_id: U, label: 'Likes Coffee', data: {} }, // same normalized label, different id
    ],
  }
  const r = planSeedAliases(dup, [])
  check('collision detected', r.collisions.length === 1 && r.collisions[0].alias_norm === 'likes coffee')
  check('collision is not double-seeded (one alias row, first id)', r.aliasRows.filter((a) => a.alias_norm === 'likes coffee').length === 1)
}

console.log('\n== duplicate clusters: drift-split rows are grouped; distinct rows are not ==')
const clusters = findDuplicateClusters(rowsByTable)
{
  const factCluster = clusters.find((c) => c.table === 'canonical_facts')
  check('the reworded dog fact is detected as a duplicate cluster', Boolean(factCluster) && factCluster.members.length === 2)
  check('distinct entities (Kara Lee vs Cole) are NOT clustered', !clusters.some((c) => c.table === 'canonical_people'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
