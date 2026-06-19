// The companion follow-ups surface (revised: conversational, no sending). All
// DETERMINISTIC, no model call: it reads the user's current canonical commitments,
// events, and people (RLS-scoped), overlays the label-drift-resilient
// companion_state, phrases each follow-up as a plain-language nudge, and adds
// relationship nudges from a simple recency heuristic. The only model calls in
// this surface are the on-demand brainstorm conversations (a separate route).
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachProvenance, type RetrievalDeps } from '@/lib/chat/retrieval'
import { matchOverlay, readOverlay, type CommitmentRef } from './overlay'
import { phraseCommitment, relationshipNudges, type RelationshipNudge } from './nudges'

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
  provenance: string | null
  sourceClaimIds: string[]
}

export type UpcomingEvent = { id: string; label: string | null; date: string | null; location: string | null }

export type Today = {
  overdue: FollowUp[]
  soon: FollowUp[]
  open: FollowUp[]
  snoozed: FollowUp[]
  relationshipNudges: RelationshipNudge[]
  upcomingEvents: UpcomingEvent[]
  counts: { active: number; snoozed: number; nudges: number; events: number }
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

async function peopleFor(
  supabase: SupabaseClient,
  userId: string,
  personIds: string[]
): Promise<Map<string, { label: string | null; workOrPersonal: string | null }>> {
  const out = new Map<string, { label: string | null; workOrPersonal: string | null }>()
  const ids = [...new Set(personIds.filter(Boolean))]
  if (ids.length === 0) return out
  const { data } = await supabase.from('canonical_people').select('id, label, data').eq('user_id', userId).in('id', ids)
  for (const r of (data ?? []) as Array<{ id: string; label: string | null; data: Record<string, unknown> | null }>) {
    out.set(r.id, { label: r.label, workOrPersonal: str((r.data ?? {}).work_or_personal) })
  }
  return out
}

export async function getToday(deps: RetrievalDeps, nowMs: number): Promise<Today> {
  const { supabase, userId } = deps
  const [{ data: commitmentData, error: cErr }, { data: eventData }, overlay, nudges] = await Promise.all([
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
  ])
  if (cErr) throw new Error(`[companion] read commitments: ${cErr.message}`)

  const commitments = (commitmentData ?? []) as CommitmentRow[]
  const refs: CommitmentRef[] = commitments.map((c) => ({ id: c.id, label: c.label, personId: str((c.data ?? {}).person_id) }))
  const stateByCommitment = matchOverlay(refs, overlay)

  const personIds = commitments.map((c) => str((c.data ?? {}).person_id) ?? '').filter(Boolean)
  const people = await peopleFor(supabase, userId, personIds)

  type Active = CommitmentRow & { _state: ReturnType<typeof stateByCommitment.get>; _snoozedFuture: boolean }
  const active: Active[] = []
  const snoozedFuture: Active[] = []
  for (const c of commitments) {
    const st = stateByCommitment.get(c.id)
    const minedStatus = (str((c.data ?? {}).status) ?? 'open').toLowerCase()
    const effective = (st?.state ?? minedStatus).toLowerCase()
    if (effective === 'done' || effective === 'dismissed') continue
    const snoozedFutureFlag = effective === 'snoozed' && Boolean(st?.snooze_until) && Date.parse(st!.snooze_until!) > nowMs
    const row: Active = { ...c, _state: st, _snoozedFuture: snoozedFutureFlag }
    if (snoozedFutureFlag) snoozedFuture.push(row)
    else active.push(row)
  }

  const toFollowUp = (rows: Active[]) =>
    rows.map((c) => {
      const data = c.data ?? {}
      const pid = str(data.person_id)
      const p = pid ? people.get(pid) : undefined
      const phrased = phraseCommitment(c.label, p?.label ?? null, str(data.due))
      return {
        id: c.id,
        commitmentId: c.id,
        headline: phrased.headline,
        suggestion: phrased.suggestion,
        due: str(data.due),
        status: (c._state?.state ?? str(data.status) ?? 'open').toLowerCase(),
        person: pid ? { id: pid, label: p?.label ?? null, workOrPersonal: p?.workOrPersonal ?? null } : null,
        bucket: bucketOf(str(data.due), c._state?.snooze_until ?? null, nowMs),
        snoozeUntil: c._state?.snooze_until ?? null,
        sourceClaimIds: c.source_claim_ids ?? [],
        source_claim_ids: c.source_claim_ids ?? [],
      }
    })

  const [activeWithProv, snoozedWithProv] = await Promise.all([
    attachProvenance(deps, toFollowUp(active)),
    attachProvenance(deps, toFollowUp(snoozedFuture)),
  ])

  const finalize = (x: (typeof activeWithProv)[number]): FollowUp => ({
    commitmentId: x.commitmentId,
    headline: x.headline,
    suggestion: x.suggestion,
    due: x.due,
    status: x.status,
    person: x.person,
    bucket: x.bucket,
    snoozeUntil: x.snoozeUntil,
    provenance: x.provenance,
    sourceClaimIds: x.sourceClaimIds,
  })

  const items = activeWithProv.map(finalize)
  const snoozed = snoozedWithProv.map(finalize)

  const upcomingEvents: UpcomingEvent[] = ((eventData ?? []) as CommitmentRow[]).map((e) => ({
    id: e.id,
    label: e.label,
    date: str((e.data ?? {}).date),
    location: str((e.data ?? {}).location),
  }))

  return {
    overdue: items.filter((i) => i.bucket === 'overdue'),
    soon: items.filter((i) => i.bucket === 'soon'),
    open: items.filter((i) => i.bucket === 'open'),
    snoozed,
    relationshipNudges: nudges,
    upcomingEvents,
    counts: { active: items.length, snoozed: snoozed.length, nudges: nudges.length, events: upcomingEvents.length },
  }
}
