// The companion follow-ups surface (revised: conversational, no sending). All
// DETERMINISTIC, no model call: it reads the user's current canonical commitments,
// events, and people (RLS-scoped), overlays the label-drift-resilient
// companion_state, phrases each follow-up as a plain-language nudge, and adds
// relationship nudges from a simple recency heuristic. The only model calls in
// this surface are the on-demand brainstorm conversations (a separate route).
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachProvenance, type RetrievalDeps } from '@/lib/chat/retrieval'
import { firstLast, personDisplay } from '@/lib/names'
import { matchOverlay, readOverlay, type CommitmentRef } from './overlay'
import { phraseCommitment, relationshipNudges, type RelationshipNudge } from './nudges'
import { resolveTiming } from './timing'

export type { RetrievalDeps } from '@/lib/chat/retrieval'

type Bucket = 'overdue' | 'soon' | 'open'

export type FollowUp = {
  commitmentId: string
  headline: string
  suggestion: string
  due: string | null
  status: string
  person: { id: string | null; label: string | null; workOrPersonal: string | null } | null
  bucket: Bucket
  snoozeUntil: string | null
  // light, user-owned tracking from the overlay (never an external action)
  dueDate: string | null
  linkedPerson: { id: string; name: string } | null
  // time-sensitivity (inferred by the miner, overridable by the user)
  timeSensitive: boolean
  deadline: string | null
  passed: boolean
  // the user's explicit override (null = using the inferred value), so the control reflects it
  timeSensitiveOverride: boolean | null
  provenance: string | null
  sourceClaimIds: string[]
}

export type UpcomingEvent = { id: string; label: string | null; date: string | null; location: string | null }

export type Today = {
  overdue: FollowUp[]
  soon: FollowUp[]
  open: FollowUp[]
  snoozed: FollowUp[]
  // time-sensitive items whose deadline has passed: kept out of the main tab (hygiene)
  // but never deleted; surfaced in a separate read-time view.
  past: FollowUp[]
  // every non-dismissed follow-up (open + done + snoozed + past), for the query/filter.
  all: FollowUp[]
  relationshipNudges: RelationshipNudge[]
  upcomingEvents: UpcomingEvent[]
  // people (id + display name) for the "link a person" picker
  people: Array<{ id: string; name: string }>
  counts: { active: number; snoozed: number; past: number; nudges: number; events: number }
}

type CommitmentRow = {
  id: string
  label: string | null
  data: Record<string, unknown> | null
  source_claim_ids: string[] | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

// Best-effort bucketing over the free-text dues plus the real snooze timestamp. It
// recognizes common signals and falls back to "open"; it never hides an item, only
// orders it. An elapsed snooze always resurfaces as overdue.
export function bucketOf(due: string | null, snoozeUntil: string | null, now: number): Bucket {
  if (snoozeUntil && Date.parse(snoozeUntil) <= now) return 'overdue'
  const d = (due ?? '').toLowerCase().trim()
  if (!d) return 'open'
  const iso = d.match(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/)
  if (iso) {
    const t = Date.parse(iso[3] ? `${iso[1]}-${iso[2]}-${iso[3]}` : `${iso[1]}-${iso[2]}-01`)
    if (Number.isFinite(t)) {
      const days = (t - now) / 86_400_000
      if (days < 0) return 'overdue'
      if (days <= 7) return 'soon'
      return 'open'
    }
  }
  if (/\b(yesterday|overdue|last week|past due|already)\b/.test(d)) return 'overdue'
  if (/\b(today|tonight|now|tomorrow|this week|this weekend|in a (couple|few) days|asap|soon)\b/.test(d)) return 'soon'
  return 'open'
}

type PersonInfo = { name: string; workOrPersonal: string | null }

// All current people once: a map (id -> name + tag) for resolving commitment and
// linked people, and a list for the "link a person" picker. The corpus is small.
async function loadPeople(
  supabase: SupabaseClient,
  userId: string
): Promise<{ byId: Map<string, PersonInfo>; list: Array<{ id: string; name: string }> }> {
  const byId = new Map<string, PersonInfo>()
  const list: Array<{ id: string; name: string }> = []
  const { data } = await supabase
    .from('canonical_people')
    .select('id, label, data')
    .eq('user_id', userId)
    .is('valid_to', null)
    .order('label', { ascending: true })
  for (const r of (data ?? []) as Array<{ id: string; label: string | null; data: Record<string, unknown> | null }>) {
    const fl = firstLast(r.label, r.data)
    const name = personDisplay(fl.first, fl.last) || r.label || 'someone'
    byId.set(r.id, { name, workOrPersonal: str((r.data ?? {}).work_or_personal) })
    list.push({ id: r.id, name })
  }
  return { byId, list }
}

export async function getToday(deps: RetrievalDeps, nowMs: number): Promise<Today> {
  const { supabase, userId } = deps
  // One parallel batch (no waterfall): commitments, events, overlay, nudges, people.
  const [{ data: commitmentData, error: cErr }, { data: eventData }, overlay, nudges, peopleData] =
    await Promise.all([
      supabase.from('canonical_commitments').select('id, label, data, source_claim_ids').eq('user_id', userId).is('valid_to', null),
      supabase
        .from('canonical_events')
        .select('id, label, data, source_claim_ids')
        .eq('user_id', userId)
        .is('valid_to', null)
        .order('created_at', { ascending: false })
        .limit(25),
      readOverlay(supabase, userId),
      relationshipNudges(deps, nowMs),
      loadPeople(supabase, userId),
    ])
  if (cErr) throw new Error(`[companion] read commitments: ${cErr.message}`)

  const commitments = (commitmentData ?? []) as CommitmentRow[]
  const refs: CommitmentRef[] = commitments.map((c) => ({ id: c.id, label: c.label, personId: str((c.data ?? {}).person_id) }))
  const stateByCommitment = matchOverlay(refs, overlay)

  const { byId: people, list: peopleList } = peopleData

  // Build a follow-up for EVERY non-dismissed commitment (open + done + snoozed +
  // past), each with its effective status and resolved time-sensitivity. The
  // categories below are derived from these; `all` is the full set the query
  // filters. Dismissed items are hidden entirely.
  type Built = FollowUp & { id: string; source_claim_ids: string[]; futureSnoozed: boolean }
  const built: Built[] = []
  for (const c of commitments) {
    const st = stateByCommitment.get(c.id)
    const data = c.data ?? {}
    const minedStatus = (str(data.status) ?? 'open').toLowerCase()
    const status = (st?.state ?? minedStatus).toLowerCase()
    if (status === 'dismissed') continue
    const pid = str(data.person_id)
    const p = pid ? people.get(pid) : undefined
    const phrased = phraseCommitment(c.label, p?.name ?? null, str(data.due))
    const linkedId = st?.linked_person_id ?? null
    const linked = linkedId ? people.get(linkedId) : undefined
    const timing = resolveTiming({
      data,
      overrideTimeSensitive: st?.time_sensitive ?? null,
      overrideDeadline: st?.due_date ?? null,
      now: nowMs,
    })
    built.push({
      id: c.id,
      commitmentId: c.id,
      headline: phrased.headline,
      suggestion: phrased.suggestion,
      due: str(data.due),
      status,
      person: pid ? { id: pid, label: p?.name ?? null, workOrPersonal: p?.workOrPersonal ?? null } : null,
      bucket: bucketOf(str(data.due), st?.snooze_until ?? null, nowMs),
      snoozeUntil: st?.snooze_until ?? null,
      dueDate: st?.due_date ?? null,
      linkedPerson: linkedId ? { id: linkedId, name: linked?.name ?? 'someone' } : null,
      timeSensitive: timing.timeSensitive,
      deadline: timing.deadline,
      passed: timing.passed,
      timeSensitiveOverride: st?.time_sensitive ?? null,
      provenance: null,
      sourceClaimIds: c.source_claim_ids ?? [],
      source_claim_ids: c.source_claim_ids ?? [],
      futureSnoozed: status === 'snoozed' && Boolean(st?.snooze_until) && Date.parse(st!.snooze_until!) > nowMs,
    })
  }

  const withProv = await attachProvenance(deps, built)
  const finalize = (x: (typeof withProv)[number]): FollowUp => ({
    commitmentId: x.commitmentId,
    headline: x.headline,
    suggestion: x.suggestion,
    due: x.due,
    status: x.status,
    person: x.person,
    bucket: x.bucket,
    snoozeUntil: x.snoozeUntil,
    dueDate: x.dueDate,
    linkedPerson: x.linkedPerson,
    timeSensitive: x.timeSensitive,
    deadline: x.deadline,
    passed: x.passed,
    timeSensitiveOverride: x.timeSensitiveOverride,
    provenance: x.provenance,
    sourceClaimIds: x.sourceClaimIds,
  })

  const isDone = (i: (typeof withProv)[number]) => i.status === 'done'
  // Main tab: active (not done, not snoozed-into-the-future) AND deadline not passed.
  const mainActive = withProv.filter((i) => !isDone(i) && !i.futureSnoozed && !i.passed).map(finalize)
  // Past: active but time-sensitive with a passed deadline. Kept, not deleted.
  const past = withProv.filter((i) => !isDone(i) && !i.futureSnoozed && i.passed).map(finalize)
  const snoozed = withProv.filter((i) => i.futureSnoozed).map(finalize)
  const allFollowUps = withProv.map(finalize)

  const upcomingEvents: UpcomingEvent[] = ((eventData ?? []) as CommitmentRow[]).map((e) => ({
    id: e.id,
    label: e.label,
    date: str((e.data ?? {}).date),
    location: str((e.data ?? {}).location),
  }))

  return {
    overdue: mainActive.filter((i) => i.bucket === 'overdue'),
    soon: mainActive.filter((i) => i.bucket === 'soon'),
    open: mainActive.filter((i) => i.bucket === 'open'),
    snoozed,
    past,
    all: allFollowUps,
    relationshipNudges: nudges,
    upcomingEvents,
    people: peopleList,
    counts: {
      active: mainActive.length,
      snoozed: snoozed.length,
      past: past.length,
      nudges: nudges.length,
      events: upcomingEvents.length,
    },
  }
}
