// Incremental derivation (MINER_INCREMENTAL, default OFF).
//
// A full recompute (derive.ts runDerivation) re-feeds ALL claims for every table to
// the model and re-emits every node on each run: ~22 minutes, growing with the
// corpus, and over the 300s in-app cap. The waste is re-deriving captures that did
// not change.
//
// Incremental processes only captures not yet incorporated into the current canonical
// graph: derive claims for just those captures (extraction is already per-capture
// incremental), resolve their entities against the EXISTING graph through the active
// resolution path, and MERGE the results in (union provenance, never overwrite),
// leaving everything derived from prior captures intact. A routine mine of a few new
// captures finishes well under the cap and costs only the new captures' API calls.
//
// The full recompute is retained (this module calls it for the baseline and for
// corrections, which are global). See docs/incremental-miner.md for the full design.
//
// This module is self-contained: the OFF path (run.ts -> runDerivation) is untouched,
// so OFF is byte-for-byte the existing behavior. The per-node row construction mirrors
// derive.ts runNodePass; keep the two in sync (a flagged-feature maintenance note).

import { admin } from './supabase'
import { logEvent } from './telemetry'
import { canonicalId, canonicalPersonId, normalizeLabel, splitName } from './identity'
import {
  asString,
  clamp01,
  getState,
  paginatedCollect,
  readCanonicalNodes,
  round3,
  salienceFrom,
  setState,
  uniqueStrings,
  validateCited,
  writeCanonical,
  type CanonNode,
} from './stage-common'
import {
  buildPeopleRewrite,
  readPeopleCorrections,
  rewriteLabel,
  type PeopleRewrite,
} from './corrections'
import {
  STAGE_A_PEOPLE_PROMPT,
  STAGE_A_PLACES_ORGS_PROMPT,
  STAGE_B_PROJECTS_PROMPT,
  STAGE_B_EVENTS_PROMPT,
  STAGE_B_FACTS_PROMPT,
  STAGE_C_RELATIONSHIPS_PROMPT,
  STAGE_C_COMMITMENTS_PROMPT,
} from './prompts.generated'
import { runDerivation } from './derive'
import { loadClaimDates, reconcileFreshness, supersedeFromDiscrepancies } from './freshness'
import { STABLE_IDENTITY, buildResolver, persistAliases } from './resolve-store'
import type { Resolver } from './resolution'
import { emptyUsage, type DiscrepancyItem, type PassResult, type TemporalClass } from './types'

export const INCREMENTAL = process.env.MINER_INCREMENTAL === '1'

// miner_state scope for the per-capture "folded into canonical" marker. A capture is
// incorporated once its claims have been merged in. Per-capture (not a high-water
// timestamp), so backfilled / out-of-order captures are handled. Reuses miner_state,
// the same table extraction already markers captures in ('extract:<id>'), so this
// needs no migration.
const incScope = (captureId: string) => `incorporated:${captureId}`
const INCORPORATED_PREFIX = 'incorporated:'
// Tracks the corrections fingerprint applied at the last baseline; a change forces a
// full recompute (rename/merge are global).
const CORR_FP_SCOPE = 'incremental:corrections_fp'

type CanonRow = {
  id: string
  user_id: string
  label: string
  data: Record<string, unknown>
  source_claim_ids: string[]
  temporality: TemporalClass
  confidence: number
  salience: number
  summary: string | null
}

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

// ---- progress markers -------------------------------------------------------

async function readCaptureIds(userId: string): Promise<string[]> {
  const { data, error } = await admin()
    .from('captures')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`[miner] incremental read captures: ${error.message}`)
  return (data ?? []).map((r) => String((r as { id: string }).id))
}

async function readIncorporatedSet(userId: string): Promise<Set<string>> {
  const { data, error } = await admin()
    .from('miner_state')
    .select('scope')
    .eq('user_id', userId)
    .like('scope', `${INCORPORATED_PREFIX}%`)
  if (error) throw new Error(`[miner] incremental read markers: ${error.message}`)
  const out = new Set<string>()
  for (const r of (data ?? []) as Array<{ scope: string }>) {
    out.add(r.scope.slice(INCORPORATED_PREFIX.length))
  }
  return out
}

// Mark captures incorporated. Only called on SUCCESS, so the marker can never run
// ahead of the canonical merge. Idempotent (upsert on the unique (user_id, scope)).
async function markIncorporated(userId: string, captureIds: string[]): Promise<void> {
  if (captureIds.length === 0) return
  const now = new Date().toISOString()
  const rows = captureIds.map((id) => ({
    user_id: userId,
    scope: incScope(id),
    input_hash: 'incorporated',
    updated_at: now,
  }))
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error } = await admin().from('miner_state').upsert(chunk, { onConflict: 'user_id,scope' })
    if (error) throw new Error(`[miner] incremental mark incorporated: ${error.message}`)
  }
}

// ---- reads scoped to the new captures + the merge read ----------------------

async function readNewRawClaims(
  userId: string,
  table: string,
  newCaptureIds: string[]
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  if (newCaptureIds.length === 0) return []
  const out: Array<{ id: string; data: Record<string, unknown> }> = []
  // chunk the IN list so a large backfill batch does not exceed URL limits
  for (let i = 0; i < newCaptureIds.length; i += 200) {
    const chunk = newCaptureIds.slice(i, i + 200)
    const { data, error } = await admin()
      .from(table)
      .select('id, data')
      .eq('user_id', userId)
      .in('capture_id', chunk)
    if (error) throw new Error(`[miner] incremental read ${table}: ${error.message}`)
    for (const r of data ?? []) {
      out.push({
        id: String((r as { id: string }).id),
        data: ((r as { data: Record<string, unknown> }).data ?? {}) as Record<string, unknown>,
      })
    }
  }
  return out
}

type MergeRow = {
  data: Record<string, unknown>
  source_claim_ids: string[]
  temporality: TemporalClass
  confidence: number
  summary: string | null
}

// Current canonical rows (valid_to is null) for the given ids, the merge target. A
// superseded id is intentionally absent: writeCanonical leaves a retired row retired,
// exactly as the full pass does when it re-emits a contradicted node.
async function readCurrentForMerge(
  userId: string,
  table: string,
  ids: string[]
): Promise<Map<string, MergeRow>> {
  const out = new Map<string, MergeRow>()
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300)
    const { data, error } = await admin()
      .from(table)
      .select('id, data, source_claim_ids, temporality, confidence, summary')
      .eq('user_id', userId)
      .is('valid_to', null)
      .in('id', chunk)
    if (error) throw new Error(`[miner] incremental merge-read ${table}: ${error.message}`)
    for (const r of (data ?? []) as Array<{
      id: string
      data: Record<string, unknown> | null
      source_claim_ids: string[] | null
      temporality: TemporalClass
      confidence: number | null
      summary: string | null
    }>) {
      out.set(String(r.id), {
        data: (r.data ?? {}) as Record<string, unknown>,
        source_claim_ids: r.source_claim_ids ?? [],
        temporality: r.temporality,
        confidence: r.confidence ?? 0.7,
        summary: r.summary,
      })
    }
  }
  return out
}

// ---- the merge (pure; the heart of incremental correctness) -----------------
// Given the rows the model emitted for the NEW claims (each with its cited new claim
// ids) and the matching CURRENT canonical rows, produce the rows to upsert. For a
// touched existing entity we UNION the new provenance into its claim set (a plain
// upsert would overwrite it), merge data, union aliases, and take the refreshed
// summary/temporality/confidence. A genuinely new entity passes through. This is
// where incremental must equal "the full pass saw all claims at once": union grouped
// by id is associative, so processing captures in batches yields the same per-id
// provenance union as one full pass. Exported for the deterministic equivalence test.
export function mergeEmitted(
  emitted: CanonRow[],
  current: Map<string, MergeRow>
): CanonRow[] {
  const out: CanonRow[] = []
  for (const em of emitted) {
    const ex = current.get(em.id)
    if (!ex) {
      out.push(em) // new entity (or a superseded id; writeCanonical leaves that retired)
      continue
    }
    const source_claim_ids = Array.from(new Set([...ex.source_claim_ids, ...em.source_claim_ids]))
    const exAliases = uniqueStrings(ex.data.aliases)
    const emAliases = uniqueStrings(em.data.aliases)
    const aliases = uniqueStrings([...exAliases, ...emAliases])
    out.push({
      id: em.id,
      user_id: em.user_id,
      // keep the established label: a new mention should not rename the entity (and
      // in the default id model the labels normalize to the same id anyway).
      label: em.label,
      data: { ...ex.data, ...em.data, aliases },
      source_claim_ids,
      temporality: em.temporality,
      confidence: em.confidence,
      // provisional; reconcileFreshness overwrites salience graph-wide afterwards.
      salience: salienceFrom(source_claim_ids.length),
      summary: em.summary ?? ex.summary,
    })
  }
  return out
}

// ---- incremental node pass --------------------------------------------------

type IncNodeConfig = {
  rawTable: string
  canonicalTable: string
  defaultTemporality: TemporalClass
  system: string
  context: CanonNode[]
  newCaptureIds: string[]
  peopleRewrite?: PeopleRewrite
}

async function incNodePass(userId: string, cfg: IncNodeConfig): Promise<PassResult> {
  const claims = await readNewRawClaims(userId, cfg.rawTable, cfg.newCaptureIds)
  if (claims.length === 0) return emptyPass(cfg.canonicalTable, true) // no new claims for this table

  const known = new Set(claims.map((c) => c.id))
  const collected = await paginatedCollect({
    ctx: `${cfg.canonicalTable} (incremental)`,
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

  // The active resolution path resolves an emitted entity against the EXISTING graph
  // (current canonical rows + persisted aliases), so a new mention of an existing
  // entity reuses its stable id instead of minting a near-duplicate.
  const resolver: Resolver | null = STABLE_IDENTITY
    ? await buildResolver(
        userId,
        cfg.canonicalTable,
        cfg.canonicalTable === 'canonical_commitments' ? { contextOf: (d) => asString(d.person_id) } : {}
      )
    : null

  // Build the emitted rows for the new claims (mirrors derive.ts runNodePass).
  const byId = new Map<string, CanonRow>()
  for (const node of collected.items) {
    const rawName = asString(node.name)
    if (!rawName) continue
    const cited = uniqueStrings(node.source_claim_ids)
    if (cited.length === 0) continue
    const name = cfg.peopleRewrite ? rewriteLabel(cfg.peopleRewrite, rawName) : rawName
    const nodeAliases = uniqueStrings(node.aliases)
    if (normalizeLabel(rawName) !== normalizeLabel(name)) nodeAliases.push(rawName)
    const isPeople = cfg.canonicalTable === 'canonical_people'
    const split = isPeople ? splitName(name) : null
    const rawData = node.data && typeof node.data === 'object' ? (node.data as Record<string, unknown>) : {}
    const nodeData = split ? { ...rawData, first_name: split.first, last_name: split.last } : rawData
    const contextKey = cfg.canonicalTable === 'canonical_commitments' ? asString(rawData.person_id) : null
    const id = resolver
      ? resolver.resolve(name, nodeAliases, contextKey).id
      : split
        ? canonicalPersonId(userId, split.first, split.last)
        : canonicalId(userId, cfg.canonicalTable, name)
    const existing = byId.get(id)
    if (existing) {
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

  const emitted = Array.from(byId.values())
  // MERGE into the existing graph: union provenance into touched current rows.
  const current = await readCurrentForMerge(userId, cfg.canonicalTable, emitted.map((r) => r.id))
  const rows = mergeEmitted(emitted, current)
  const w = await writeCanonical(userId, cfg.canonicalTable, rows)
  if (resolver) await persistAliases(userId, cfg.canonicalTable, resolver.newAliases())
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
  }
}

// ---- incremental relationships pass -----------------------------------------

async function incRelationshipsPass(
  userId: string,
  nodes: CanonNode[],
  newCaptureIds: string[]
): Promise<PassResult> {
  const table = 'canonical_relationships'
  const claims = await readNewRawClaims(userId, 'raw_relationships', newCaptureIds)
  if (claims.length === 0) return emptyPass(table, true)

  const nodeIds = new Set(nodes.map((n) => n.id))
  const labelById = new Map(nodes.map((n) => [n.id, n.label ?? '']))
  const known = new Set(claims.map((c) => c.id))
  const collected = await paginatedCollect({
    ctx: `${table} (incremental)`,
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

  const byId = new Map<string, CanonRow>()
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
    const ex = byId.get(id)
    if (ex) {
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

  const emitted = Array.from(byId.values())
  const current = await readCurrentForMerge(userId, table, emitted.map((r) => r.id))
  const rows = mergeEmitted(emitted, current)
  const w = await writeCanonical(userId, table, rows)
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
    open_threads: collected.open_threads + dropped,
    usage: collected.usage,
  }
}

// ---- orchestration ----------------------------------------------------------

export type IncrementalMode = 'full' | 'incremental' | 'noop'

// Returns the passes plus the mode taken, so the caller can log which path ran.
export async function runIncrementalDerivation(userId: string): Promise<PassResult[]> {
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
    const passes = await runDerivation(userId)
    await markIncorporated(userId, captures)
    await setState(userId, CORR_FP_SCOPE, peopleRewrite.fingerprint)
    await logEvent({
      user_id: userId,
      event_type: 'miner_run',
      name: 'incremental',
      attrs: {
        stage: 'incremental',
        mode: 'full',
        reason: !baselineExists ? 'baseline' : 'corrections_changed',
        captures: captures.length,
        new_captures: unincorporated.length,
      },
    })
    return passes
  }

  // --- NO-OP: nothing new. Keep decay anchors / salience current (cheap), else idle.
  if (unincorporated.length === 0) {
    const claimDates = await loadClaimDates(userId)
    const recon = await reconcileFreshness(userId, claimDates)
    await logEvent({
      user_id: userId,
      event_type: 'miner_run',
      name: 'incremental',
      attrs: { stage: 'incremental', mode: 'noop', captures: captures.length, new_captures: 0, ...recon },
    })
    return []
  }

  // --- INCREMENTAL: fold in only the unincorporated captures ---
  const results: PassResult[] = []

  // Stage A: people + places.
  results.push(
    await incNodePass(userId, {
      rawTable: 'raw_people',
      canonicalTable: 'canonical_people',
      defaultTemporality: 'evergreen',
      system: STAGE_A_PEOPLE_PROMPT,
      context: [],
      newCaptureIds: unincorporated,
      // apply the existing rewrite so a new mention of a renamed person routes to the
      // survivor id, never the superseded loser.
      peopleRewrite,
    })
  )
  results.push(
    await incNodePass(userId, {
      rawTable: 'raw_places_orgs',
      canonicalTable: 'canonical_places_orgs',
      defaultTemporality: 'evergreen',
      system: STAGE_A_PLACES_ORGS_PROMPT,
      context: [],
      newCaptureIds: unincorporated,
    })
  )

  const aNodes = [
    ...(await readCanonicalNodes(userId, 'canonical_people')),
    ...(await readCanonicalNodes(userId, 'canonical_places_orgs')),
  ]

  // Stage B: projects, events, facts.
  results.push(
    await incNodePass(userId, {
      rawTable: 'raw_projects',
      canonicalTable: 'canonical_projects',
      defaultTemporality: 'decaying',
      system: STAGE_B_PROJECTS_PROMPT,
      context: aNodes,
      newCaptureIds: unincorporated,
    })
  )
  results.push(
    await incNodePass(userId, {
      rawTable: 'raw_events',
      canonicalTable: 'canonical_events',
      defaultTemporality: 'dated',
      system: STAGE_B_EVENTS_PROMPT,
      context: aNodes,
      newCaptureIds: unincorporated,
    })
  )
  results.push(
    await incNodePass(userId, {
      rawTable: 'raw_facts',
      canonicalTable: 'canonical_facts',
      defaultTemporality: 'evergreen',
      system: STAGE_B_FACTS_PROMPT,
      context: [],
      newCaptureIds: unincorporated,
    })
  )

  // Stage C: relationships, commitments. Insights are GLOBAL and are intentionally
  // NOT refreshed incrementally (they need the whole graph); the full rebuild trues
  // them up. See docs/incremental-miner.md.
  const allNodes: CanonNode[] = []
  for (const t of ['canonical_people', 'canonical_places_orgs', 'canonical_projects', 'canonical_events', 'canonical_facts']) {
    allNodes.push(...(await readCanonicalNodes(userId, t)))
  }
  results.push(await incRelationshipsPass(userId, allNodes, unincorporated))
  results.push(
    await incNodePass(userId, {
      rawTable: 'raw_commitments',
      canonicalTable: 'canonical_commitments',
      defaultTemporality: 'dated',
      system: STAGE_C_COMMITMENTS_PROMPT,
      context: aNodes,
      newCaptureIds: unincorporated,
    })
  )

  // Freshness tail: supersede from the NEW captures' discrepancies (idempotent,
  // claim-id-keyed), then reconcile anchors + graph-based salience (whole-layer,
  // writes only diffs, no LLM, cheap).
  const claimDates = await loadClaimDates(userId)
  const perTable = results
    .filter((p) => p.discrepancyItems && p.discrepancyItems.length)
    .map((p) => ({ table: p.table, items: p.discrepancyItems as DiscrepancyItem[] }))
  const sup = await supersedeFromDiscrepancies(userId, perTable, claimDates)
  const recon = await reconcileFreshness(userId, claimDates)

  // Advance the markers ONLY now, after the merge + freshness succeeded.
  await markIncorporated(userId, unincorporated)

  await logEvent({
    user_id: userId,
    event_type: 'miner_run',
    name: 'incremental',
    attrs: {
      stage: 'incremental',
      mode: 'incremental',
      captures: captures.length,
      new_captures: unincorporated.length,
      superseded: sup.superseded,
      last_confirmed_updated: recon.lastConfirmedUpdated,
      salience_updated: recon.salienceUpdated,
    },
  })

  return results
}
