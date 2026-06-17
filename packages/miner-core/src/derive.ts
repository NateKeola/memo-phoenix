import { canonicalId } from './identity'
import { logEvent } from './telemetry'
import {
  asString,
  clamp01,
  getState,
  inputHash,
  paginatedCollect,
  readCanonicalNodes,
  readRawClaims,
  round3,
  salienceFrom,
  setState,
  uniqueStrings,
  validateCited,
  writeCanonical,
  type CanonNode,
} from './stage-common'
import {
  STAGE_A_PEOPLE_PROMPT,
  STAGE_A_PLACES_ORGS_PROMPT,
  STAGE_B_PROJECTS_PROMPT,
  STAGE_B_EVENTS_PROMPT,
  STAGE_B_FACTS_PROMPT,
  STAGE_C_RELATIONSHIPS_PROMPT,
  STAGE_C_COMMITMENTS_PROMPT,
  STAGE_C_INSIGHTS_PROMPT,
} from './prompts.generated'
import { addUsage, emptyUsage, type PassResult, type TemporalClass } from './types'

const A_NODE_TABLES = ['canonical_people', 'canonical_places_orgs']
const ALL_NODE_TABLES = [
  'canonical_people',
  'canonical_places_orgs',
  'canonical_projects',
  'canonical_events',
  'canonical_facts',
]

function temporality(v: unknown, dflt: TemporalClass): TemporalClass {
  return v === 'evergreen' || v === 'dated' || v === 'decaying' ? (v as TemporalClass) : dflt
}

function emptyPass(table: string, skipped: boolean): PassResult {
  return {
    table,
    skipped,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rows: 0,
    batches: 0,
    discrepancies: 0,
    open_threads: 0,
    usage: emptyUsage(),
  }
}

// ---- node pass (people, places_orgs, projects, events, facts, commitments) --

type NodePassConfig = {
  rawTable: string
  canonicalTable: string
  defaultTemporality: TemporalClass
  system: string
  context: CanonNode[] // resolved Stage A/B nodes the model may reference (may be empty)
}

async function runNodePass(userId: string, cfg: NodePassConfig): Promise<PassResult> {
  const claims = await readRawClaims(userId, cfg.rawTable)
  const ctxKey = cfg.context.map((n) => ({ id: n.id, label: n.label, aliases: n.aliases }))
  const hash = inputHash([cfg.canonicalTable, claims, ctxKey])
  const scope = `derive:${cfg.canonicalTable}`
  if ((await getState(userId, scope)) === hash) return emptyPass(cfg.canonicalTable, true)
  if (claims.length === 0) {
    await setState(userId, scope, hash)
    return emptyPass(cfg.canonicalTable, false)
  }

  const known = new Set(claims.map((c) => c.id))
  const collected = await paginatedCollect({
    ctx: cfg.canonicalTable,
    system: cfg.system,
    itemsField: 'nodes',
    labelOf: (n) => asString(n.name),
    buildUser: (already, batchLimit) =>
      JSON.stringify({
        claims: claims.map((c) => ({ id: c.id, data: c.data })),
        canonical_nodes: cfg.context.map((n) => ({ id: n.id, label: n.label, aliases: n.aliases, type: n.type })),
        already_emitted: already,
        batch_limit: batchLimit,
      }),
    validate: (batch) => {
      for (const node of batch) {
        const cited = uniqueStrings(node.source_claim_ids)
        validateCited(cited, known, `${cfg.canonicalTable} node "${asString(node.name) ?? '(unnamed)'}"`)
        if (cited.length === 0) {
          throw new Error(`[miner] ${cfg.canonicalTable}: node "${asString(node.name) ?? '(unnamed)'}" has empty source_claim_ids`)
        }
      }
    },
  })

  const byId = new Map<string, {
    id: string
    user_id: string
    label: string
    data: Record<string, unknown>
    source_claim_ids: string[]
    temporality: TemporalClass
    confidence: number
    salience: number
    summary: string | null
  }>()
  for (const node of collected.items) {
    const name = asString(node.name)
    if (!name) continue
    const cited = uniqueStrings(node.source_claim_ids)
    if (cited.length === 0) continue
    const id = canonicalId(userId, cfg.canonicalTable, name)
    const nodeData = (node.data && typeof node.data === 'object' ? (node.data as Record<string, unknown>) : {})
    const existing = byId.get(id)
    if (existing) {
      // two surface forms normalized to the same id: union provenance, merge data
      // fields, and union aliases (aliases live inside data).
      existing.source_claim_ids = Array.from(new Set([...existing.source_claim_ids, ...cited]))
      const mergedAliases = uniqueStrings([...uniqueStrings(existing.data.aliases), ...uniqueStrings(node.aliases)])
      existing.data = { ...existing.data, ...nodeData, aliases: mergedAliases }
      existing.salience = salienceFrom(existing.source_claim_ids.length)
      continue
    }
    byId.set(id, {
      id,
      user_id: userId,
      label: name,
      data: { ...nodeData, aliases: uniqueStrings(node.aliases) },
      source_claim_ids: cited,
      temporality: temporality(node.temporality, cfg.defaultTemporality),
      confidence: round3(clamp01(node.confidence, 0.7)),
      salience: salienceFrom(cited.length),
      summary: asString(node.summary),
    })
  }

  const rows = Array.from(byId.values())
  const w = await writeCanonical(userId, cfg.canonicalTable, rows)
  await setState(userId, scope, hash)
  return {
    table: cfg.canonicalTable,
    skipped: false,
    inserted: w.inserted,
    updated: w.updated,
    unchanged: w.unchanged,
    rows: rows.length,
    batches: collected.batches,
    discrepancies: collected.discrepancies,
    open_threads: collected.open_threads,
    usage: collected.usage,
  }
}

// ---- relationships pass (edges between resolved nodes) ----------------------

async function runRelationshipsPass(userId: string, nodes: CanonNode[]): Promise<PassResult> {
  const table = 'canonical_relationships'
  const claims = await readRawClaims(userId, 'raw_relationships')
  const nodeIds = new Set(nodes.map((n) => n.id))
  const labelById = new Map(nodes.map((n) => [n.id, n.label ?? '']))
  const hash = inputHash([table, claims, nodes.map((n) => ({ id: n.id, label: n.label, aliases: n.aliases }))])
  const scope = `derive:${table}`
  if ((await getState(userId, scope)) === hash) return emptyPass(table, true)
  if (claims.length === 0) {
    await setState(userId, scope, hash)
    return emptyPass(table, false)
  }

  const known = new Set(claims.map((c) => c.id))
  const collected = await paginatedCollect({
    ctx: table,
    system: STAGE_C_RELATIONSHIPS_PROMPT,
    itemsField: 'edges',
    labelOf: (e) => `${asString(e.source_id) ?? ''}|${asString(e.target_id) ?? ''}|${(asString(e.relation) ?? '').toLowerCase()}`,
    buildUser: (already, batchLimit) =>
      JSON.stringify({
        relationship_claims: claims.map((c) => ({ id: c.id, data: c.data })),
        canonical_nodes: nodes.map((n) => ({ id: n.id, label: n.label, aliases: n.aliases, type: n.type })),
        already_emitted: already,
        batch_limit: batchLimit,
      }),
    validate: (batch) => {
      for (const edge of batch) {
        const cited = uniqueStrings(edge.source_claim_ids)
        validateCited(cited, known, `${table} edge`)
        if (cited.length === 0) throw new Error(`[miner] ${table}: an edge has empty source_claim_ids`)
      }
    },
  })

  const byId = new Map<string, {
    id: string
    user_id: string
    label: string
    data: Record<string, unknown>
    source_claim_ids: string[]
    temporality: TemporalClass
    confidence: number
    salience: number
    summary: string | null
  }>()
  let dropped = 0
  for (const edge of collected.items) {
    const sourceId = asString(edge.source_id)
    const targetId = asString(edge.target_id)
    const relation = asString(edge.relation)
    if (!sourceId || !targetId || !relation || !nodeIds.has(sourceId) || !nodeIds.has(targetId)) {
      dropped++
      continue
    }
    const cited = uniqueStrings(edge.source_claim_ids)
    if (cited.length === 0) continue
    const key = `${sourceId}|${targetId}|${relation.toLowerCase()}`
    const id = canonicalId(userId, table, key)
    const edgeData = edge.data && typeof edge.data === 'object' ? (edge.data as Record<string, unknown>) : {}
    if (byId.has(id)) {
      const ex = byId.get(id)!
      ex.source_claim_ids = Array.from(new Set([...ex.source_claim_ids, ...cited]))
      ex.data = { ...ex.data, ...edgeData, source_id: sourceId, target_id: targetId, relation }
      ex.salience = salienceFrom(ex.source_claim_ids.length)
      continue
    }
    const label = `${labelById.get(sourceId) ?? sourceId} ${relation} ${labelById.get(targetId) ?? targetId}`
    byId.set(id, {
      id,
      user_id: userId,
      label,
      data: { ...edgeData, source_id: sourceId, target_id: targetId, relation },
      source_claim_ids: cited,
      temporality: temporality(edge.temporality, 'evergreen'),
      confidence: round3(clamp01(edge.confidence, 0.7)),
      salience: salienceFrom(cited.length),
      summary: asString(edge.summary),
    })
  }

  const rows = Array.from(byId.values())
  const w = await writeCanonical(userId, table, rows)
  await setState(userId, scope, hash)
  return {
    table,
    skipped: false,
    inserted: w.inserted,
    updated: w.updated,
    unchanged: w.unchanged,
    rows: rows.length,
    batches: collected.batches,
    discrepancies: collected.discrepancies,
    open_threads: collected.open_threads + dropped, // unresolved endpoints become threads
    usage: collected.usage,
  }
}

// ---- insights pass (cross-corpus patterns over the canonical layer) ---------

async function runInsightsPass(userId: string, nodes: CanonNode[]): Promise<PassResult> {
  const table = 'insights'
  const rels = await readCanonicalNodes(userId, 'canonical_relationships')
  const layer = {
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, summary: n.summary, source_claim_ids: n.source_claim_ids })),
    relationships: rels.map((r) => ({ id: r.id, label: r.label, summary: r.summary })),
  }
  const hash = inputHash([table, layer])
  const scope = `derive:${table}`
  if ((await getState(userId, scope)) === hash) return emptyPass(table, true)
  if (nodes.length === 0) {
    await setState(userId, scope, hash)
    return emptyPass(table, false)
  }

  // provenance for insights is the raw ids that underpin the canonical layer
  const known = new Set<string>()
  for (const n of nodes) for (const id of n.source_claim_ids) known.add(id)

  const collected = await paginatedCollect({
    ctx: table,
    system: STAGE_C_INSIGHTS_PROMPT,
    itemsField: 'insights',
    labelOf: (i) => asString(i.statement),
    buildUser: (already, batchLimit) =>
      JSON.stringify({ canonical_layer: layer, already_emitted: already, batch_limit: batchLimit }),
    validate: (batch) => {
      for (const ins of batch) {
        const cited = uniqueStrings(ins.supporting_claim_ids)
        if (cited.length === 0) throw new Error(`[miner] ${table}: an insight has empty supporting_claim_ids`)
        validateCited(cited, known, `${table} insight`)
      }
    },
  })

  const byId = new Map<string, {
    id: string
    user_id: string
    label: string
    data: Record<string, unknown>
    source_claim_ids: string[]
    temporality: TemporalClass
    confidence: number
    salience: number
    summary: string | null
  }>()
  for (const ins of collected.items) {
    const statement = asString(ins.statement)
    if (!statement) continue
    const cited = uniqueStrings(ins.supporting_claim_ids)
    if (cited.length === 0) continue
    const id = canonicalId(userId, table, statement)
    if (byId.has(id)) continue
    byId.set(id, {
      id,
      user_id: userId,
      label: asString(ins.pattern_type) ?? statement.slice(0, 80),
      data: {
        statement,
        pattern_type: asString(ins.pattern_type),
        affected_entity_ids: uniqueStrings(ins.affected_entity_ids),
      },
      source_claim_ids: cited,
      temporality: temporality(ins.temporality, 'decaying'),
      confidence: round3(clamp01(ins.confidence, 0.6)),
      salience: salienceFrom(cited.length),
      summary: statement,
    })
  }

  const rows = Array.from(byId.values())
  const w = await writeCanonical(userId, table, rows)
  await setState(userId, scope, hash)
  return {
    table,
    skipped: false,
    inserted: w.inserted,
    updated: w.updated,
    unchanged: w.unchanged,
    rows: rows.length,
    batches: collected.batches,
    discrepancies: collected.discrepancies,
    open_threads: collected.open_threads,
    usage: collected.usage,
  }
}

// ---- orchestration: A -> B -> C --------------------------------------------

export async function runDerivation(userId: string): Promise<PassResult[]> {
  const results: PassResult[] = []
  const record = async (stage: string, p: PassResult) => {
    results.push(p)
    await logEvent({
      user_id: userId,
      event_type: 'miner_run',
      name: `${stage}:${p.table}`,
      duration_ms: undefined,
      attrs: {
        stage,
        table: p.table,
        skipped: p.skipped,
        rows: p.rows,
        inserted: p.inserted,
        updated: p.updated,
        unchanged: p.unchanged,
        batches: p.batches,
        discrepancies: p.discrepancies,
        open_threads: p.open_threads,
        tokens_in: p.usage.input_tokens,
        tokens_out: p.usage.output_tokens,
        cache_read: p.usage.cache_read_input_tokens,
        cache_creation: p.usage.cache_creation_input_tokens,
      },
    })
  }

  // Stage A: people + places/orgs (independent, run concurrently). These resolve
  // first; everything downstream references them.
  const aPeople = await runNodePass(userId, {
    rawTable: 'raw_people',
    canonicalTable: 'canonical_people',
    defaultTemporality: 'evergreen',
    system: STAGE_A_PEOPLE_PROMPT,
    context: [],
  })
  const aPlaces = await runNodePass(userId, {
    rawTable: 'raw_places_orgs',
    canonicalTable: 'canonical_places_orgs',
    defaultTemporality: 'evergreen',
    system: STAGE_A_PLACES_ORGS_PROMPT,
    context: [],
  })
  await record('stage_a', aPeople)
  await record('stage_a', aPlaces)

  // Resolved Stage A node set, used as reference context for B and C.
  const aNodes = [
    ...(await readCanonicalNodes(userId, 'canonical_people')),
    ...(await readCanonicalNodes(userId, 'canonical_places_orgs')),
  ]

  // Stage B: projects, events, facts.
  const bProjects = await runNodePass(userId, {
    rawTable: 'raw_projects',
    canonicalTable: 'canonical_projects',
    defaultTemporality: 'decaying',
    system: STAGE_B_PROJECTS_PROMPT,
    context: aNodes,
  })
  const bEvents = await runNodePass(userId, {
    rawTable: 'raw_events',
    canonicalTable: 'canonical_events',
    defaultTemporality: 'dated',
    system: STAGE_B_EVENTS_PROMPT,
    context: aNodes,
  })
  const bFacts = await runNodePass(userId, {
    rawTable: 'raw_facts',
    canonicalTable: 'canonical_facts',
    defaultTemporality: 'evergreen',
    system: STAGE_B_FACTS_PROMPT,
    context: [],
  })
  await record('stage_b', bProjects)
  await record('stage_b', bEvents)
  await record('stage_b', bFacts)

  // Full resolved node set for Stage C.
  const allNodes: CanonNode[] = []
  for (const t of ALL_NODE_TABLES) allNodes.push(...(await readCanonicalNodes(userId, t)))

  // Stage C: relationships, commitments, insights (cross-cutting, last).
  const cRel = await runRelationshipsPass(userId, allNodes)
  await record('stage_c', cRel)

  const cCommit = await runNodePass(userId, {
    rawTable: 'raw_commitments',
    canonicalTable: 'canonical_commitments',
    defaultTemporality: 'dated',
    system: STAGE_C_COMMITMENTS_PROMPT,
    context: aNodes,
  })
  await record('stage_c', cCommit)

  const cInsights = await runInsightsPass(userId, allNodes)
  await record('stage_c', cInsights)

  return results
}

export { A_NODE_TABLES, ALL_NODE_TABLES }
