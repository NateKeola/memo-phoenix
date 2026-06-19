'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
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
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'unauthorized' }
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

// Light, user-owned tracking on a follow-up: when they intend to do it and who
// with. Stored in the overlay only. Never schedules or sends anything.
export async function setFollowupTracking(input: {
  commitmentId: string
  dueDate?: string | null
  linkedPersonId?: string | null
  matchLabel?: string | null
  matchPersonId?: string | null
}): Promise<StateResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'unauthorized' }

  // normalize an empty date / person to null (clearing the field). Validate the
  // date BEFORE converting, so a bad value returns an error rather than throwing.
  const rawDate = (input.dueDate ?? '').trim()
  if (rawDate && Number.isNaN(Date.parse(rawDate))) return { ok: false, error: 'invalid date' }
  const dueDate = rawDate ? new Date(rawDate).toISOString() : null
  const linkedPersonId = input.linkedPersonId && input.linkedPersonId.trim() ? input.linkedPersonId : null

  const err = await patchCompanionState(supabase, user.id, input.commitmentId, {
    due_date: dueDate,
    linked_person_id: linkedPersonId,
    match_label: input.matchLabel ?? null,
    match_person_id: input.matchPersonId ?? null,
  })
  if (err) return { ok: false, error: err }

  await logEvent({
    user_id: user.id,
    event_type: 'companion_tracking',
    name: 'followup',
    attrs: { commitment_id: input.commitmentId, has_date: Boolean(dueDate), linked_person: Boolean(linkedPersonId) },
  })
  revalidatePath('/companion')
  return { ok: true }
}
