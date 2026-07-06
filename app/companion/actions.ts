'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { authorizeAction } from '@/lib/auth/guard'
import { logEvent } from '@/lib/telemetry'

// The companion does NOT send email or create calendar events. It writes only the
// commitment overlay (done / snooze / dismiss) and light, user-owned tracking (an
// intended date and a linked person) in companion_state, never in canonical, never
// an external action. Brainstorm conversations run through /api/companion/brainstorm.

export type StateResult = { ok: boolean; error?: string }

type CompanionStatePatch = {
  state?: 'open' | 'done' | 'snoozed' | 'dismissed'
  snooze_until?: string | null
  match_label?: string | null
  match_person_id?: string | null
  due_date?: string | null
  linked_person_id?: string | null
  time_sensitive?: boolean | null
}

// Read-merge-upsert so two surfaces (state buttons, follow-up tracking) writing to
// the same companion_state row do not clobber each other's fields.
async function patchCompanionState(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  commitmentId: string,
  patch: CompanionStatePatch
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('companion_state')
    .select('*')
    .eq('user_id', userId)
    .eq('commitment_id', commitmentId)
    .maybeSingle()
  const base = (existing as Record<string, unknown> | null) ?? { state: 'open' }
  const row = {
    ...base,
    user_id: userId,
    commitment_id: commitmentId,
    ...patch,
    updated_at: new Date().toISOString(),
  }
  delete (row as { id?: unknown }).id
  delete (row as { created_at?: unknown }).created_at
  const { error } = await supabase.from('companion_state').upsert(row, { onConflict: 'user_id,commitment_id' })
  return error ? error.message : null
}

export async function setCommitmentState(input: {
  commitmentId: string
  state: 'open' | 'done' | 'snoozed' | 'dismissed'
  snoozeDays?: number
  matchLabel?: string | null
  matchPersonId?: string | null
}): Promise<StateResult> {
  const auth = await authorizeAction()
  if (!auth.ok) return { ok: false, error: auth.reason === 'forbidden' ? 'not authorized' : 'unauthorized' }
  const { supabase, user } = auth
  if (!['open', 'done', 'snoozed', 'dismissed'].includes(input.state)) return { ok: false, error: 'bad state' }

  const snoozeUntil =
    input.state === 'snoozed'
      ? new Date(Date.now() + Math.max(1, input.snoozeDays ?? 3) * 86_400_000).toISOString()
      : null

  const err = await patchCompanionState(supabase, user.id, input.commitmentId, {
    state: input.state,
    snooze_until: snoozeUntil,
    match_label: input.matchLabel ?? null,
    match_person_id: input.matchPersonId ?? null,
  })
  if (err) return { ok: false, error: err }

  await logEvent({
    user_id: user.id,
    event_type: 'companion_state',
    name: input.state,
    attrs: { commitment_id: input.commitmentId, snooze_until: snoozeUntil },
  })
  revalidatePath('/companion')
  return { ok: true }
}

// Light, user-owned tracking + time-sensitivity on a follow-up: a deadline
// (due_date, which also drives the time-passed hygiene), a linked person, and an
// explicit time-sensitive override (true / false / null=use the miner-inferred
// value). Stored in the overlay only. Never schedules or sends anything.
export async function setFollowupTracking(input: {
  commitmentId: string
  dueDate?: string | null
  linkedPersonId?: string | null
  timeSensitive?: boolean | null
  matchLabel?: string | null
  matchPersonId?: string | null
}): Promise<StateResult> {
  const auth = await authorizeAction()
  if (!auth.ok) return { ok: false, error: auth.reason === 'forbidden' ? 'not authorized' : 'unauthorized' }
  const { supabase, user } = auth

  // normalize an empty date / person to null (clearing the field). Validate the
  // date BEFORE converting, so a bad value returns an error rather than throwing.
  const rawDate = (input.dueDate ?? '').trim()
  if (rawDate && Number.isNaN(Date.parse(rawDate))) return { ok: false, error: 'invalid date' }
  const dueDate = rawDate ? new Date(rawDate).toISOString() : null
  const linkedPersonId = input.linkedPersonId && input.linkedPersonId.trim() ? input.linkedPersonId : null
  const timeSensitive = input.timeSensitive === undefined ? undefined : input.timeSensitive

  const err = await patchCompanionState(supabase, user.id, input.commitmentId, {
    due_date: dueDate,
    linked_person_id: linkedPersonId,
    ...(timeSensitive === undefined ? {} : { time_sensitive: timeSensitive }),
    match_label: input.matchLabel ?? null,
    match_person_id: input.matchPersonId ?? null,
  })
  if (err) return { ok: false, error: err }

  await logEvent({
    user_id: user.id,
    event_type: 'companion_tracking',
    name: 'followup',
    attrs: {
      commitment_id: input.commitmentId,
      has_date: Boolean(dueDate),
      linked_person: Boolean(linkedPersonId),
      time_sensitive: timeSensitive ?? null,
    },
  })
  revalidatePath('/companion')
  return { ok: true }
}

// User-set work/personal tag on an event. Like the person tag, but user-classified
// via the event_tags OVERLAY (never a canonical edit; the miner owns canonical).
// value null clears the tag (deletes the overlay row). Keyed on the canonical event
// id, RLS-scoped to the signed-in user.
export async function setEventTag(input: {
  eventId: string
  workOrPersonal: 'work' | 'personal' | null
}): Promise<StateResult> {
  const auth = await authorizeAction()
  if (!auth.ok) return { ok: false, error: auth.reason === 'forbidden' ? 'not authorized' : 'unauthorized' }
  const { supabase, user } = auth
  if (!input.eventId) return { ok: false, error: 'missing event' }
  const value = input.workOrPersonal
  if (value !== null && value !== 'work' && value !== 'personal') return { ok: false, error: 'bad tag' }

  if (value === null) {
    const { error } = await supabase.from('event_tags').delete().eq('user_id', user.id).eq('event_id', input.eventId)
    if (error) return { ok: false, error: error.message }
  } else {
    const { error } = await supabase.from('event_tags').upsert(
      { user_id: user.id, event_id: input.eventId, work_or_personal: value, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,event_id' }
    )
    if (error) return { ok: false, error: error.message }
  }

  await logEvent({ user_id: user.id, event_type: 'event_tag', name: value ?? 'cleared', attrs: { event_id: input.eventId } })
  revalidatePath('/companion')
  return { ok: true }
}
