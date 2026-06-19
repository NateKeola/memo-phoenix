// Structured retrieval over the canonical layer (spec §10, primary path).
//
// Each tool here is a DETERMINISTIC database query, not an LLM call. The chat
// model routes to these tools and composes an answer from their results; it never
// receives the whole graph. Queries are scoped to the signed-in user two ways:
// RLS (the passed client is the request's RLS-bound anon client) AND an explicit
// `user_id` filter (defense in depth, and so the same code is testable with a
// service-role client scoped to one user).
//
// The corpus is single-user and small (tens to low hundreds of rows per type),
// so tools fetch the current rows of one type and rank/filter in code rather than
// pushing fuzzy jsonb matching into SQL. The whole graph is never sent to the
// model: tools return a compact, matched subset.
//
// Validity-aware (spec §3): tools read current rows (`valid_to is null`) by
// default and return the validity fields so the composer can annotate an aged
// fact as past ("as of <date>") rather than asserting it as present.
import type { SupabaseClient } from '@supabase/supabase-js'
import { effectiveConfidence, isAged } from '@/lib/freshness/decay'

// Canonical type tables the model can reference, keyed by a short, stable name.
export const CANONICAL_TABLES = {
  person: 'canonical_people',
  place: 'canonical_places_orgs',
  project: 'canonical_projects',
  event: 'canonical_events',
  fact: 'canonical_facts',
  relationship: 'canonical_relationships',
  commitment: 'canonical_commitments',
  insight: 'insights',
} as const
export type CanonicalType = keyof typeof CANONICAL_TABLES

// The 8 raw tables a claim id may live in (for provenance resolution). An
// insight's claims can span several of these, so provenance searches all of them.
const RAW_TABLES = [
  'raw_people',
  'raw_places_orgs',
  'raw_projects',
  'raw_events',
  'raw_facts',
  'raw_relationships',
  'raw_commitments',
  'raw_collection_mentions',
] as const

// Columns every canonical row shares. `data` is loose jsonb (per open decision #3).
const ROW_COLUMNS =
  'id, label, data, summary, temporality, valid_from, valid_to, confidence, salience, source_claim_ids, last_confirmed_at, created_at'

type Row = {
  id: string
  label: string | null
  data: Record<string, unknown> | null
  summary: string | null
  temporality: string
  valid_from: string | null
  valid_to: string | null
  confidence: number
  salience: number
  source_claim_ids: string[] | null
  last_confirmed_at: string | null
  created_at: string
}

function d(row: Row): Record<string, unknown> {
  return (row.data ?? {}) as Record<string, unknown>
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const dt = new Date(t)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`
}

// A compact, model-facing projection of a canonical row. The full `data` blob is
// flattened to a few useful keys plus a passthrough of the rest, keeping the
// model's context small while preserving validity + provenance handles.
function project(type: CanonicalType, row: Row) {
  const data = d(row)
  const now = Date.now()
  const fresh = { temporality: row.temporality, confidence: row.confidence, lastConfirmedAt: row.last_confirmed_at }
  // Validity-aware (spec §3): a superseded row is past; a current decaying row that
  // has faded and not been confirmed in a while is still current but should be
  // spoken of "as of" its last confirmation, not asserted as present fact.
  let validity: { current: boolean; aged?: boolean; as_of?: string | null }
  if (row.valid_to !== null) {
    validity = { current: false, as_of: fmtDate(row.valid_to) }
  } else if (isAged(fresh, now)) {
    validity = { current: true, aged: true, as_of: fmtDate(row.last_confirmed_at) }
  } else {
    validity = { current: true }
  }
  return {
    id: row.id,
    type,
    label: row.label,
    summary: row.summary,
    temporality: row.temporality,
    ...validity,
    // report the DECAYED confidence so the model naturally hedges an aged fact;
    // for evergreen/dated/fresh rows this equals the stored confidence.
    confidence: round(effectiveConfidence(fresh, now)),
    data,
    source_claim_ids: row.source_claim_ids ?? [],
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

// Score a row against a free-text query (token overlap on label + summary + data).
function scoreMatch(row: Row, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const hay = `${asStr(row.label)} ${asStr(row.summary)} ${JSON.stringify(d(row))}`.toLowerCase()
  if (hay.includes(q)) return 100
  const tokens = q.split(/\s+/).filter((t) => t.length > 1)
  if (tokens.length === 0) return 0
  let hits = 0
  for (const t of tokens) if (hay.includes(t)) hits++
  return (hits / tokens.length) * 80
}

// Does a person row match a name query (label or any alias)?
function nameMatches(row: Row, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const label = asStr(row.label).toLowerCase()
  if (label === q) return 100
  const aliases = (d(row).aliases as unknown[] | undefined) ?? []
  const aliasStrs = aliases.map((a) => asStr(a).toLowerCase())
  if (aliasStrs.includes(q)) return 95
  if (label.includes(q) || q.includes(label)) return 80
  for (const a of aliasStrs) if (a.includes(q) || q.includes(a)) return 75
  // token overlap as a last resort (handles "Karalea" vs "Kara Lee")
  return scoreMatch(row, query) * 0.6
}

export type RetrievalDeps = { supabase: SupabaseClient; userId: string }

// Fetch current rows of one canonical type (valid_to is null), user-scoped.
async function fetchCurrent(deps: RetrievalDeps, type: CanonicalType, limit = 500): Promise<Row[]> {
  const { data, error } = await deps.supabase
    .from(CANONICAL_TABLES[type])
    .select(ROW_COLUMNS)
    .eq('user_id', deps.userId)
    .is('valid_to', null)
    .order('salience', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`[retrieval] ${type}: ${error.message}`)
  return (data ?? []) as Row[]
}

// Resolve a set of canonical node ids to {id,label,type} across all canonical
// tables (used to name relationship endpoints, commitment people, related ids).
async function resolveNodes(
  deps: RetrievalDeps,
  ids: string[]
): Promise<Record<string, { id: string; label: string | null; type: CanonicalType }>> {
  const out: Record<string, { id: string; label: string | null; type: CanonicalType }> = {}
  const want = [...new Set(ids.filter(Boolean))]
  if (want.length === 0) return out
  await Promise.all(
    (Object.keys(CANONICAL_TABLES) as CanonicalType[]).map(async (type) => {
      const { data } = await deps.supabase
        .from(CANONICAL_TABLES[type])
        .select('id, label')
        .eq('user_id', deps.userId)
        .in('id', want)
      for (const r of (data ?? []) as { id: string; label: string | null }[]) {
        out[r.id] = { id: r.id, label: r.label, type }
      }
    })
  )
  return out
}

export type ProvenanceHit = {
  capture_id: string
  mode: string
  modality: string | null
  date: string | null
  snippet: string
}

// Resolve raw claim ids to the captures they came from. A claim id lives in
// exactly one raw_* table; we search all of them (an insight's claims span types)
// then read the originating captures. This is the provenance x-ray (spec §11).
export async function resolveProvenance(
  deps: RetrievalDeps,
  claimIds: string[]
): Promise<ProvenanceHit[]> {
  const ids = [...new Set(claimIds.filter(Boolean))]
  if (ids.length === 0) return []
  const captureIds = new Set<string>()
  await Promise.all(
    RAW_TABLES.map(async (t) => {
      const { data } = await deps.supabase
        .from(t)
        .select('capture_id')
        .eq('user_id', deps.userId)
        .in('id', ids)
      for (const r of (data ?? []) as { capture_id: string }[]) {
        if (r.capture_id) captureIds.add(r.capture_id)
      }
    })
  )
  if (captureIds.size === 0) return []
  const { data: caps } = await deps.supabase
    .from('captures')
    .select('id, mode, modality, body, created_at')
    .eq('user_id', deps.userId)
    .in('id', [...captureIds])
    .order('created_at', { ascending: true }) // earliest first, so [0] is the first mention
  return ((caps ?? []) as { id: string; mode: string; modality: string | null; body: string | null; created_at: string }[]).map(
    (c) => ({
      capture_id: c.id,
      mode: c.mode,
      modality: c.modality,
      date: fmtDate(c.created_at),
      snippet: asStr(c.body).replace(/\s+/g, ' ').slice(0, 240),
    })
  )
}

// A one-line provenance hint attached inline to factual rows, so provenance is
// always available to the composer without a second model decision. Best-effort:
// resolves the first claim of each row in one batched pass.
export async function attachProvenance<T extends { id: string; source_claim_ids: string[] }>(
  deps: RetrievalDeps,
  rows: T[]
): Promise<Array<T & { provenance: string | null }>> {
  const firstClaim = new Map<string, string>()
  for (const r of rows) {
    const c = r.source_claim_ids?.[0]
    if (c) firstClaim.set(r.id, c)
  }
  const claims = [...new Set([...firstClaim.values()])]
  if (claims.length === 0) return rows.map((r) => ({ ...r, provenance: null }))

  // claim id -> capture meta, in one pass over the raw tables.
  const claimToCapture = new Map<string, string>()
  await Promise.all(
    RAW_TABLES.map(async (t) => {
      const { data } = await deps.supabase
        .from(t)
        .select('id, capture_id')
        .eq('user_id', deps.userId)
        .in('id', claims)
      for (const r of (data ?? []) as { id: string; capture_id: string }[]) {
        claimToCapture.set(r.id, r.capture_id)
      }
    })
  )
  const captureIds = [...new Set([...claimToCapture.values()])]
  const capMeta = new Map<string, { mode: string; date: string | null }>()
  if (captureIds.length > 0) {
    const { data: caps } = await deps.supabase
      .from('captures')
      .select('id, mode, created_at')
      .eq('user_id', deps.userId)
      .in('id', captureIds)
    for (const c of (caps ?? []) as { id: string; mode: string; created_at: string }[]) {
      capMeta.set(c.id, { mode: c.mode, date: fmtDate(c.created_at) })
    }
  }
  return rows.map((r) => {
    const claim = firstClaim.get(r.id)
    const capId = claim ? claimToCapture.get(claim) : undefined
    const meta = capId ? capMeta.get(capId) : undefined
    const hint = meta ? `from your ${meta.mode}${meta.date ? ` on ${meta.date}` : ''}` : null
    return { ...r, provenance: hint }
  })
}

// ----- The tools -----------------------------------------------------------

export async function getPerson(deps: RetrievalDeps, name: string) {
  const rows = await fetchCurrent(deps, 'person')
  const ranked = rows
    .map((r) => ({ r, score: nameMatches(r, name) }))
    .filter((x) => x.score > 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => project('person', x.r))
  return attachProvenance(deps, ranked)
}

export async function getProject(deps: RetrievalDeps, name?: string) {
  const rows = await fetchCurrent(deps, 'project')
  const picked = name && name.trim()
    ? rows
        .map((r) => ({ r, score: scoreMatch(r, name) }))
        .filter((x) => x.score > 30)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map((x) => x.r)
    : rows.slice(0, 12)
  return attachProvenance(deps, picked.map((r) => project('project', r)))
}

export async function findCommitments(
  deps: RetrievalDeps,
  opts: { status?: string; person?: string; query?: string } = {}
) {
  const rows = await fetchCurrent(deps, 'commitment')
  const wantStatus = opts.status?.trim().toLowerCase()
  let picked = rows.filter((r) => {
    const status = asStr(d(r).status).toLowerCase()
    if (wantStatus) return status === wantStatus
    return status !== 'done' // default: everything still owed
  })
  if (opts.query && opts.query.trim()) {
    picked = picked
      .map((r) => ({ r, score: scoreMatch(r, opts.query!) }))
      .filter((x) => x.score > 20)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r)
  }
  // resolve linked people so the model sees names, not ids (over the full set,
  // before any cap, so the person filter below cannot miss a low-salience match)
  const personIds = picked.map((r) => asStr(d(r).person_id)).filter(Boolean)
  const nodes = await resolveNodes(deps, personIds)
  // Filter by person BEFORE the cap: otherwise a commitment for the named person
  // that ranks past the 25th by salience would be sliced away before it is seen.
  if (opts.person && opts.person.trim()) {
    const q = opts.person.trim().toLowerCase()
    picked = picked.filter((r) => {
      const pid = asStr(d(r).person_id)
      const label = pid ? nodes[pid]?.label ?? '' : ''
      return label.toLowerCase().includes(q)
    })
  }
  const projected = picked.slice(0, 25).map((r) => {
    const data = d(r)
    const pid = asStr(data.person_id)
    return {
      ...project('commitment', r),
      due: data.due ?? null,
      status: data.status ?? 'open',
      person: pid ? nodes[pid]?.label ?? null : null,
    }
  })
  return attachProvenance(deps, projected)
}

// "What is coming up": current events plus everything still owed. Dates in this
// corpus are free text ("tomorrow", "in a couple weeks"), so we return them
// verbatim for the model to read rather than trying to parse a calendar.
export async function listUpcoming(deps: RetrievalDeps, limit = 15) {
  const [eventRows, commitmentRows] = await Promise.all([
    fetchCurrent(deps, 'event'),
    fetchCurrent(deps, 'commitment'),
  ])
  const ev = eventRows.slice(0, limit).map((r) => ({
    ...project('event', r),
    date: d(r).date ?? null,
    location: d(r).location ?? null,
  }))
  const com = commitmentRows
    .filter((r) => asStr(d(r).status).toLowerCase() !== 'done')
    .slice(0, limit)
    .map((r) => ({ ...project('commitment', r), due: d(r).due ?? null, status: d(r).status ?? 'open' }))
  // resolve provenance per list so each keeps its distinct shape (date vs due)
  const [events, commitments] = await Promise.all([attachProvenance(deps, ev), attachProvenance(deps, com)])
  return { events, commitments }
}

export async function searchFacts(
  deps: RetrievalDeps,
  query: string,
  includeInsights = false
) {
  const types: CanonicalType[] = includeInsights ? ['fact', 'insight'] : ['fact']
  const all = (await Promise.all(types.map((t) => fetchCurrent(deps, t).then((rs) => rs.map((r) => ({ t, r })))))).flat()
  const ranked = all
    .map((x) => ({ ...x, score: scoreMatch(x.r, query) }))
    .filter((x) => x.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => project(x.t, x.r))
  return attachProvenance(deps, ranked)
}

export async function neighborsOf(deps: RetrievalDeps, nodeId: string) {
  const rels = await fetchCurrent(deps, 'relationship')
  const connected = rels.filter((r) => {
    const data = d(r)
    return asStr(data.source_id) === nodeId || asStr(data.target_id) === nodeId
  })
  const otherIds = connected.map((r) => {
    const data = d(r)
    return asStr(data.source_id) === nodeId ? asStr(data.target_id) : asStr(data.source_id)
  })
  const nodes = await resolveNodes(deps, [nodeId, ...otherIds])
  const center = nodes[nodeId] ?? null
  const edges = connected.map((r) => {
    const data = d(r)
    const isSource = asStr(data.source_id) === nodeId
    const otherId = isSource ? asStr(data.target_id) : asStr(data.source_id)
    return {
      relation: data.relation ?? null,
      direction: isSource ? 'outgoing' : 'incoming',
      other: nodes[otherId]
        ? { id: otherId, label: nodes[otherId].label, type: nodes[otherId].type as string | null }
        : { id: otherId, label: null, type: null as string | null },
      label: r.label,
      summary: r.summary,
    }
  })
  return { center, edge_count: edges.length, edges }
}

export async function listRecent(deps: RetrievalDeps, type: CanonicalType, limit = 10) {
  const rows = await fetchCurrent(deps, type)
  // fetchCurrent sorts by salience; for "recent" re-sort by created_at desc.
  const recent = [...rows]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, Math.min(Math.max(limit, 1), 25))
    .map((r) => project(type, r))
  return attachProvenance(deps, recent)
}

// Escape LIKE/ILIKE metacharacters so a name containing % or _ matches literally
// rather than acting as a wildcard.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export async function listInCollection(deps: RetrievalDeps, name: string) {
  const { data: cols } = await deps.supabase
    .from('collections')
    .select('id, name, created_by')
    .eq('user_id', deps.userId)
    .ilike('name', `%${escapeLike(name)}%`)
  const collections = (cols ?? []) as { id: string; name: string; created_by: string }[]
  if (collections.length === 0) return { collections: [], items: [] }
  const ids = collections.map((c) => c.id)
  const { data: items } = await deps.supabase
    .from('collection_items')
    .select('id, collection_id, data, source_claim_ids')
    .eq('user_id', deps.userId)
    .in('collection_id', ids)
  return { collections, items: (items ?? []) as unknown[] }
}

export async function getProvenance(deps: RetrievalDeps, claimIds: string[]) {
  const hits = await resolveProvenance(deps, claimIds)
  return { sources: hits }
}
