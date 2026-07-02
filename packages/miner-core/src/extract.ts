import { callClaude, parseModelObject } from './anthropic'
import { admin } from './supabase'
import { canonicalJson, rawId, sha256 } from './identity'
import { getState, setState } from './stage-common'
import { EXTRACTION_PROMPT } from './prompts.generated'
import type { Usage } from './types'
import { emptyUsage } from './types'

// db.json section -> raw table. The 8 working-set sections (spec 4.3).
const SECTION_TABLE: Record<string, string> = {
  people: 'raw_people',
  places_orgs: 'raw_places_orgs',
  projects: 'raw_projects',
  events: 'raw_events',
  facts: 'raw_facts',
  relationships: 'raw_relationships',
  commitments: 'raw_commitments',
  collection_mentions: 'raw_collection_mentions',
}

export type Capture = {
  id: string
  user_id: string
  mode: string
  modality: string
  body: string | null
  // capture-with-target: what this capture is about, so extracted context attaches
  // to the intended thing rather than the model guessing.
  target_kind?: string | null
  target_id?: string | null
}

// Resolve the capture's target to a short context line prepended to the extraction
// input (the stored capture body is NOT modified). This is how the miner honors
// the target: it tells the extraction model what the note is about, so the people,
// facts, and relationships in it attribute to the intended person/commitment.
async function resolveTargetLine(capture: Capture): Promise<string | null> {
  const { target_kind: kind, target_id: id, user_id: userId } = capture
  if (kind === 'person' && id) {
    // The target may have been superseded since the capture was written (a merge or
    // rename retired it); follow superseded_by once so the context line names the
    // SURVIVOR, not a retired label (attributing to a retired label would re-mint it).
    type PersonRow = {
      label: string | null
      data: Record<string, unknown> | null
      valid_to?: string | null
      superseded_by?: string | null
    }
    const { data } = await admin()
      .from('canonical_people')
      .select('label, data, valid_to, superseded_by')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle()
    let row: PersonRow | null = (data as PersonRow | null) ?? null
    if (row && row.valid_to && row.superseded_by) {
      const { data: surv } = await admin()
        .from('canonical_people')
        .select('label, data')
        .eq('user_id', userId)
        .eq('id', row.superseded_by)
        .is('valid_to', null)
        .maybeSingle()
      if (surv) row = surv as PersonRow
    }
    if (row) {
      const d = (row.data ?? {}) as Record<string, unknown>
      const name =
        `${typeof d.first_name === 'string' ? d.first_name : ''} ${typeof d.last_name === 'string' ? d.last_name : ''}`.trim() ||
        row.label ||
        'this person'
      return `Context: this note is about the person ${name}. Attribute the people, facts, and relationships in it to ${name} where it fits.`
    }
  }
  if (kind === 'commitment' && id) {
    const { data } = await admin()
      .from('canonical_commitments')
      .select('label')
      .eq('user_id', userId)
      .eq('id', id)
      .is('valid_to', null)
      .maybeSingle()
    const label = (data as { label: string | null } | null)?.label
    if (label) return `Context: this note adds detail to the follow-up "${label}".`
  }
  // a 'topic' target's context is already woven into the seeded interview transcript
  return null
}

export type ExtractResult = {
  captureId: string
  skipped: boolean
  rawInserted: number
  bySection: Record<string, number>
  usage: Usage
}

// Per-table raw-row counts for a capture. Used by the crash-recovery guard above;
// only called for captures without an extract marker, so the 8 head-count probes
// cost nothing on the steady-state path.
async function captureRawCounts(userId: string, captureId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of Object.values(SECTION_TABLE)) {
    const { count, error } = await admin()
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('capture_id', captureId)
    if (error) throw new Error(`[miner] probe ${table} for ${captureId}: ${error.message}`)
    out[table] = count ?? 0
  }
  return out
}

// Extract one capture into the raw layer. Idempotent: a capture is append-only
// and immutable, so it is extracted exactly once (tracked in miner_state, never
// as a column on captures, which is hard append-only). Raw ids are
// deterministic, and the insert is ON CONFLICT DO NOTHING, so a partial re-run
// cannot violate the append-only trigger.
export async function extractCapture(capture: Capture): Promise<ExtractResult> {
  const scope = `extract:${capture.id}`
  const bySection: Record<string, number> = {}
  if (await getState(capture.user_id, scope)) {
    return { captureId: capture.id, skipped: true, rawInserted: 0, bySection, usage: emptyUsage() }
  }

  const body = (capture.body ?? '').trim()
  if (!body) {
    await setState(capture.user_id, scope, sha256('empty'))
    return { captureId: capture.id, skipped: false, rawInserted: 0, bySection, usage: emptyUsage() }
  }

  // Crash-recovery guard: if the marker is missing but raw rows for this capture
  // already exist, a previous run died between the raw insert and setState. A fresh
  // LLM call would reword the items into DIFFERENT content hashes and permanently
  // append near-duplicate claims next to the originals (raw is hard append-only).
  // Treat the existing rows as the completed extraction: set the marker and skip.
  // (The vulnerable window is the seconds of insert time, not the minutes of model
  // time, so a partially-inserted capture is rare; provenance is still consistent
  // either way because every raw row carries its capture_id.)
  const preexisting = await captureRawCounts(capture.user_id, capture.id)
  if (Object.values(preexisting).some((n) => n > 0)) {
    // Log the PER-TABLE shape so a suspicious partial (rows in only one of the
    // tables a conversation would normally populate) is visible to an operator;
    // the guard itself cannot distinguish partial from complete, and re-extracting
    // would permanently append reworded duplicates, so recovery is the lesser harm.
    console.warn(
      `[miner] extract ${capture.id}: raw rows already present without a marker; recovering (no re-extraction). ` +
        `per-table: ${JSON.stringify(preexisting)}`
    )
    const user = JSON.stringify({ mode: capture.mode, modality: capture.modality, body })
    await setState(capture.user_id, scope, sha256(user))
    return { captureId: capture.id, skipped: true, rawInserted: 0, bySection, usage: emptyUsage() }
  }

  const aboutLine = await resolveTargetLine(capture)
  const extractBody = aboutLine ? `${aboutLine}\n\n${body}` : body
  const user = JSON.stringify({ mode: capture.mode, modality: capture.modality, body: extractBody })
  const res = await callClaude(EXTRACTION_PROMPT, user)
  const parsed = parseModelObject(res.raw, `extract capture ${capture.id}`)

  let rawInserted = 0
  for (const [section, table] of Object.entries(SECTION_TABLE)) {
    const items = Array.isArray(parsed[section]) ? (parsed[section] as unknown[]) : []
    const occ = new Map<string, number>()
    const rows = items
      .filter((it) => it && typeof it === 'object')
      .map((it) => {
        const data = it as Record<string, unknown>
        const ch = sha256(canonicalJson(data))
        const n = occ.get(ch) ?? 0
        occ.set(ch, n + 1)
        return {
          id: rawId(capture.user_id, capture.id, table, ch, n),
          capture_id: capture.id,
          user_id: capture.user_id,
          data,
        }
      })
    if (rows.length > 0) {
      // ON CONFLICT DO NOTHING: safe to re-run, never fires the append-only trigger.
      const { error } = await admin().from(table).upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
      if (error) throw new Error(`[miner] insert ${table}: ${error.message}`)
      bySection[section] = rows.length
      rawInserted += rows.length
    }
  }

  // hash the full LLM input (mode + modality + body), so a re-extraction is
  // skipped only when the exact input is unchanged.
  await setState(capture.user_id, scope, sha256(user))
  return { captureId: capture.id, skipped: false, rawInserted, bySection, usage: res.usage }
}
