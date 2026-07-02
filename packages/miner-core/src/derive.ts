import { canonicalId, canonicalPersonId, normalizeLabel, splitName } from './identity'
import {
  buildPeopleRewrite,
  readPeopleCorrections,
  repointReferences,
  resolveSurvivorIds,
  retireStaleRelationships,
  rewriteLabel,
  supersedeLosers,
  type PeopleRewrite,
} from './corrections'
import { logEvent } from './telemetry'
import {
  asString,
  clamp01,
  getState,
  inputHash,
  paginatedCollect,
  readCanonicalNodes,
  readExcludedClaimIds,
  readRawClaims,
  retireAbsorbedRows,
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
import { addUsage, emptyUsage, type DiscrepancyItem, type PassResult, type TemporalClass } from './types'
import { loadClaimDates, reconcileFreshness, supersedeFromDiscrepancies } from './freshness'
import { STABLE_IDENTITY, buildResolver, persistAliases } from './resolve-store'
import type { Resolver } from './resolution'

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
  // people-identity corrections (people pass only): rewrite resolved labels before
  // the deterministic id is computed, so renames and merges survive recompute.
  peopleRewrite?: PeopleRewrite
  // run heartbeat, invoked before every model call inside the pass
  heartbeat?: () => Promise<void>
}

async function runNodePass(userId: string, cfg: NodePassConfig): Promise<PassResult> {
  const claims = await readRawClaims(userId, cfg.rawTable)
  const ctxKey = cfg.context.map((n) => ({ id: n.id, label: n.label, aliases: n.aliases }))
  // The corrections fingerprint is part of the input: a new rename/merge busts the
  // people pass memo so the rewrite is actually re-applied.
  // The identity mode is part of the input: flipping MINER_STABLE_IDENTITY busts
  // the memo so the next mine re-resolves through the resolver and seeds aliases.
  const hash = inputHash([
    cfg.canonicalTable,
    claims,
    ctxKey,
    cfg.peopleRewrite?.fingerprint ?? '',
    STABLE_IDENTITY ? 'resolve' : 'hash',
  ])
  const scope = `derive:${cfg.canonicalTable}`
  if ((await getState(userId, scope)) === hash) return emptyPass(cfg.canonicalTable, true)
  if (claims.length === 0) {
    // No admissible claims can mean ALL of this table's evidence was retracted
    // (capture_exclusions); the exclusion contract still requires retiring the rows
    // that cited it, else they would stay current forever behind the memo.
    const excludedClaims = await readExcludedClaimIds(userId, cfg.rawTable)
    const r = await retireAbsorbedRows(userId, cfg.canonicalTable, [], excludedClaims)
    await setState(userId, scope, hash)
    return { ...emptyPass(cfg.canonicalTable, false), retired: r.retired }
  }

  const known = new Set(claims.map((c) => c.id))
  const collected = await paginatedCollect({
    ctx: cfg.canonicalTable,
    system: cfg.system,
    heartbeat: cfg.heartbeat,
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

  // Stable-identity resolver (gated). Reads current canonical rows + persisted
  // aliases for this table so an incoming entity resolves to its existing stable id
  // instead of a fresh label hash. Commitments disambiguate on the linked person.
  const resolver: Resolver | null = STABLE_IDENTITY
    ? await buildResolver(
        userId,
        cfg.canonicalTable,
        cfg.canonicalTable === 'canonical_commitments' ? { contextOf: (d) => asString(d.person_id) } : {}
      )
    : null

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
    const rawName = asString(node.name)
    if (!rawName) continue
    const cited = uniqueStrings(node.source_claim_ids)
    if (cited.length === 0) continue
    // Apply a people correction: rewrite the surface form to the survivor label
    // BEFORE the id is derived, so a renamed/merged person resolves to one id and
    // every later mention of the old name lands on the survivor, not a duplicate.
    const name = cfg.peopleRewrite ? rewriteLabel(cfg.peopleRewrite, rawName) : rawName
    const nodeAliases = uniqueStrings(node.aliases)
    // keep the original surface form as an alias so the correction is self-stable
    if (normalizeLabel(rawName) !== normalizeLabel(name)) nodeAliases.push(rawName)
    const isPeople = cfg.canonicalTable === 'canonical_people'
    const split = isPeople ? splitName(name) : null
    const rawData = (node.data && typeof node.data === 'object' ? (node.data as Record<string, unknown>) : {})
    const nodeData = split ? { ...rawData, first_name: split.first, last_name: split.last } : rawData
    // STABLE IDENTITY: resolve to an existing stable id (exact -> alias -> fuzzy),
    // minting a random id only on no match, so a label drift updates the alias map
    // not the id. OFF: the prior label-derived id (people on first+last, which
    // reconstructs the label so existing ids are preserved).
    const contextKey = cfg.canonicalTable === 'canonical_commitments' ? asString(rawData.person_id) : null
    const id = resolver
      ? resolver.resolve(name, nodeAliases, contextKey).id
      : split
        ? canonicalPersonId(userId, split.first, split.last)
        : canonicalId(userId, cfg.canonicalTable, name)
    const existing = byId.get(id)
    if (existing) {
      // two surface forms normalized to the same id (a merge, or just casing): union
      // provenance, merge data fields, and union aliases (aliases live inside data).
      existing.source_claim_ids = Array.from(new Set([...existing.source_claim_ids, ...cited]))
      const mergedAliases = uniqueStrings([...uniqueStrings(existing.data.aliases), ...nodeAliases])
      existing.data = { ...existing.data, ...nodeData, aliases: mergedAliases }
      existing.salience = salienceFrom(existing.source_claim_ids.length)
      continue
    }
    byId.set(id, {
      id,
      user_id: userId,
      label: name,
      data: { ...nodeData, aliases: nodeAliases },
      source_claim_ids: cited,
      temporality: temporality(node.temporality, cfg.defaultTemporality),
      confidence: round3(clamp01(node.confidence, 0.7)),
      salience: salienceFrom(cited.length),
      summary: asString(node.summary),
    })
  }

  const rows = Array.from(byId.values())
  const w = await writeCanonical(userId, cfg.canonicalTable, rows)
  if (resolver) await persistAliases(userId, cfg.canonicalTable, resolver.newAliases())
  // Convergence: a full pass re-examined EVERY admissible claim, so a current row
  // that was not re-emitted and whose evidence was fully attributed elsewhere (or
  // retracted via capture_exclusions) is an absorbed duplicate; retire it. Rows
  // writeCanonical kept retired are excluded from attribution/successors.
  const excludedClaims = await readExcludedClaimIds(userId, cfg.rawTable)
  const ret = await retireAbsorbedRows(
    userId,
    cfg.canonicalTable,
    rows.map((r) => ({ id: r.id, source_claim_ids: r.source_claim_ids })),
    excludedClaims,
    new Set(w.keptRetiredIds)
  )
  // A retired PERSON can be embedded by id in label-keyed rows (commitment
  // person_id, project/event related_ids, insight affected_entity_ids), and the
  // change-signature skips data-only rewrites, so repoint those references to the
  // successor now (same mechanism the corrections path uses).
  if (cfg.canonicalTable === 'canonical_people' && ret.mapping.size > 0) {
    const repointMap = new Map<string, string>()
    for (const [loser, successor] of ret.mapping) if (successor) repointMap.set(loser, successor)
    if (repointMap.size > 0) await repointReferences(userId, repointMap)
  }
  const retired = ret.retired
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
    discrepancyItems: collected.discrepancyItems,
    open_threads: collected.open_threads,
    usage: collected.usage,
    retired,
  }
}

// ---- relationships pass (edges between resolved nodes) ----------------------

async function runRelationshipsPass(
  userId: string,
  nodes: CanonNode[],
  heartbeat?: () => Promise<void>
): Promise<PassResult> {
  const table = 'canonical_relationships'
  const claims = await readRawClaims(userId, 'raw_relationships')
  const nodeIds = new Set(nodes.map((n) => n.id))
  const labelById = new Map(nodes.map((n) => [n.id, n.label ?? '']))
  const hash = inputHash([table, claims, nodes.map((n) => ({ id: n.id, label: n.label, aliases: n.aliases }))])
  const scope = `derive:${table}`
  if ((await getState(userId, scope)) === hash) return emptyPass(table, true)
  if (claims.length === 0) {
    const excludedClaims = await readExcludedClaimIds(userId, 'raw_relationships')
    const r = await retireAbsorbedRows(userId, table, [], excludedClaims)
    await setState(userId, scope, hash)
    return { ...emptyPass(table, false), retired: r.retired }
  }

  const known = new Set(claims.map((c) => c.id))
  const collected = await paginatedCollect({
    ctx: table,
    system: STAGE_C_RELATIONSHIPS_PROMPT,
    heartbeat,
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
  const excludedClaims = await readExcludedClaimIds(userId, 'raw_relationships')
  const { retired } = await retireAbsorbedRows(
    userId,
    table,
    rows.map((r) => ({ id: r.id, source_claim_ids: r.source_claim_ids })),
    excludedClaims,
    new Set(w.keptRetiredIds)
  )
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
    discrepancyItems: collected.discrepancyItems,
    open_threads: collected.open_threads + dropped, // unresolved endpoints become threads
    usage: collected.usage,
    retired,
  }
}

// ---- insights pass (cross-corpus patterns over the canonical layer) ---------

async function runInsightsPass(
  userId: string,
  nodes: CanonNode[],
  heartbeat?: () => Promise<void>
): Promise<PassResult> {
  const table = 'insights'
  const rels = await readCanonicalNodes(userId, 'canonical_relationships')
  const layer = {
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, summary: n.summary, source_claim_ids: n.source_claim_ids })),
    relationships: rels.map((r) => ({ id: r.id, label: r.label, summary: r.summary })),
  }
  const hash = inputHash([table, layer, STABLE_IDENTITY ? 'resolve' : 'hash'])
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
    heartbeat,
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

  // Insights are identified by their statement (not the pattern_type label), and
  // statement rewording is the worst churn source, so fuzzy resolution helps most.
  const resolver: Resolver | null = STABLE_IDENTITY
    ? await buildResolver(userId, table, { labelOf: (d) => asString(d.statement) })
    : null

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
    const id = resolver ? resolver.resolve(statement).id : canonicalId(userId, table, statement)
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
  if (resolver) await persistAliases(userId, table, resolver.newAliases())
  // Insights are re-derived from the whole canonical layer each full run; a stale
  // reworded insight whose supporting claims were re-cited by the fresh set is
  // absorbed (this is what stops the recurring_tension pile-up). No excluded-claim
  // set here: insight provenance spans all raw tables and the absorbed rule alone
  // converges it.
  const { retired } = await retireAbsorbedRows(
    userId,
    table,
    rows.map((r) => ({ id: r.id, source_claim_ids: r.source_claim_ids })),
    new Set<string>(),
    new Set(w.keptRetiredIds)
  )
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
    discrepancyItems: collected.discrepancyItems,
    open_threads: collected.open_threads,
    usage: collected.usage,
    retired,
  }
}

// ---- orchestration: A -> B -> C --------------------------------------------

export async function runDerivation(
  userId: string,
  onStage?: (stage: string) => Promise<void>
): Promise<PassResult[]> {
  const results: PassResult[] = []
  const stage = async (s: string) => {
    if (onStage) await onStage(s)
  }
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

  // People-identity corrections (renames, merges) are read once and applied as a
  // label rewrite in the people pass, then enforced by superseding the stale rows.
  const corrections = await readPeopleCorrections(userId)
  const peopleRewrite = buildPeopleRewrite(userId, corrections)

  // Stage A: people + places/orgs (independent, run concurrently). These resolve
  // first; everything downstream references them.
  await stage('canonical_people')
  const aPeople = await runNodePass(userId, {
    rawTable: 'raw_people',
    canonicalTable: 'canonical_people',
    defaultTemporality: 'evergreen',
    system: STAGE_A_PEOPLE_PROMPT,
    context: [],
    peopleRewrite,
    heartbeat: onStage ? () => onStage('canonical_people') : undefined,
  })
  await stage('canonical_places_orgs')
  const aPlaces = await runNodePass(userId, {
    rawTable: 'raw_places_orgs',
    canonicalTable: 'canonical_places_orgs',
    defaultTemporality: 'evergreen',
    system: STAGE_A_PLACES_ORGS_PROMPT,
    context: [],
    heartbeat: onStage ? () => onStage('canonical_places_orgs') : undefined,
  })
  await record('stage_a', aPeople)
  await record('stage_a', aPlaces)

  // Retire the merged-away loser person rows BEFORE downstream context is read, so
  // B and C never see a superseded identity. The survivor id is resolved from the
  // CURRENT rows the people pass just wrote (by label), never recomputed from a
  // label hash; a survivor that did not materialize skips its loser (no dangling
  // superseded_by). Idempotent: a no-op once applied.
  const loserToSurvivor = await resolveSurvivorIds(userId, peopleRewrite.loserToSurvivorLabel)
  const losersSuperseded = await supersedeLosers(userId, loserToSurvivor)

  // Resolved Stage A node set, used as reference context for B and C.
  const aNodes = [
    ...(await readCanonicalNodes(userId, 'canonical_people')),
    ...(await readCanonicalNodes(userId, 'canonical_places_orgs')),
  ]

  // Stage B: projects, events, facts.
  await stage('canonical_projects')
  const bProjects = await runNodePass(userId, {
    rawTable: 'raw_projects',
    canonicalTable: 'canonical_projects',
    defaultTemporality: 'decaying',
    system: STAGE_B_PROJECTS_PROMPT,
    context: aNodes,
    heartbeat: onStage ? () => onStage('canonical_projects') : undefined,
  })
  await stage('canonical_events')
  const bEvents = await runNodePass(userId, {
    rawTable: 'raw_events',
    canonicalTable: 'canonical_events',
    defaultTemporality: 'dated',
    system: STAGE_B_EVENTS_PROMPT,
    context: aNodes,
    heartbeat: onStage ? () => onStage('canonical_events') : undefined,
  })
  await stage('canonical_facts')
  const bFacts = await runNodePass(userId, {
    rawTable: 'raw_facts',
    canonicalTable: 'canonical_facts',
    defaultTemporality: 'evergreen',
    system: STAGE_B_FACTS_PROMPT,
    context: [],
    heartbeat: onStage ? () => onStage('canonical_facts') : undefined,
  })
  await record('stage_b', bProjects)
  await record('stage_b', bEvents)
  await record('stage_b', bFacts)

  // Full resolved node set for Stage C.
  const allNodes: CanonNode[] = []
  for (const t of ALL_NODE_TABLES) allNodes.push(...(await readCanonicalNodes(userId, t)))

  // Stage C: relationships, commitments, insights (cross-cutting, last).
  await stage('canonical_relationships')
  const cRel = await runRelationshipsPass(userId, allNodes, onStage ? () => onStage('canonical_relationships') : undefined)
  await record('stage_c', cRel)

  await stage('canonical_commitments')
  const cCommit = await runNodePass(userId, {
    rawTable: 'raw_commitments',
    canonicalTable: 'canonical_commitments',
    defaultTemporality: 'dated',
    system: STAGE_C_COMMITMENTS_PROMPT,
    context: aNodes,
    heartbeat: onStage ? () => onStage('canonical_commitments') : undefined,
  })
  await record('stage_c', cCommit)

  await stage('insights')
  const cInsights = await runInsightsPass(userId, allNodes, onStage ? () => onStage('insights') : undefined)
  await record('stage_c', cInsights)

  // After re-resolution, clean up downstream references to a merged-away person.
  // Relationship edges are keyed on their endpoints, so the stale loser edge is
  // retired (the survivor edge was re-emitted under a new id). Label-keyed rows
  // (commitments, projects, events, insights) keep the same id across a person
  // merge, so their embedded person reference is repointed in place.
  const relationshipsRetired = await retireStaleRelationships(userId, new Set(loserToSurvivor.keys()))
  const referencesRepointed = await repointReferences(userId, loserToSurvivor)

  if (corrections.length > 0) {
    await logEvent({
      user_id: userId,
      event_type: 'corrections_applied',
      name: 'people',
      attrs: {
        corrections: corrections.length,
        rewrites: peopleRewrite.labelToFinal.size,
        losers: loserToSurvivor.size,
        losers_superseded: losersSuperseded,
        relationships_retired: relationshipsRetired,
        references_repointed: referencesRepointed,
      },
    })
  }

  // ---- the freshness loop (spec §3, PR8) ----
  // Runs last, over the freshly-written canonical layer. Deterministic: it
  // supersedes contradicted rows (from the discrepancies the model flagged) and
  // maintains each node's decay anchor (last_confirmed_at) + salience. Decay
  // CONFIDENCE itself is computed at read time (lib/freshness in the app), never
  // persisted, so a moving clock never churns canonical_history. This phase writes
  // only rows that actually changed, so an unchanged corpus stays a no-op.
  await stage('freshness')
  const claimDates = await loadClaimDates(userId)
  const perTable = results
    .filter((p) => p.discrepancyItems && p.discrepancyItems.length)
    .map((p) => ({ table: p.table, items: p.discrepancyItems as DiscrepancyItem[] }))
  const sup = await supersedeFromDiscrepancies(userId, perTable, claimDates)
  const recon = await reconcileFreshness(userId, claimDates)
  await logEvent({
    user_id: userId,
    event_type: 'miner_run',
    name: 'freshness',
    attrs: {
      stage: 'freshness',
      superseded: sup.superseded,
      references_repointed: sup.repointed,
      last_confirmed_updated: recon.lastConfirmedUpdated,
      salience_updated: recon.salienceUpdated,
      renewed: recon.renewed, // decay clocks that moved forward (a re-confirmation)
    },
  })

  return results
}

export { A_NODE_TABLES, ALL_NODE_TABLES }
