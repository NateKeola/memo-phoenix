'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logEvent } from '@/lib/telemetry'

// The companion does NOT send email or create calendar events (that sending layer
// is deferred to a later settings/connectors build). The only state it writes is
// the commitment overlay (done / snooze / dismiss), in companion_state, never in
// canonical. Brainstorm conversations run through /api/companion/brainstorm.

export type StateResult = { ok: boolean; error?: string }

export async function setCommitmentState(input: {
  commitmentId: string
  state: 'open' | 'done' | 'snoozed' | 'dismissed'
  snoozeDays?: number
  // a stable signature stored so the overlay survives a commitment label drift
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

  const { error } = await supabase.from('companion_state').upsert(
    {
      user_id: user.id,
      commitment_id: input.commitmentId,
      state: input.state,
      snooze_until: snoozeUntil,
      match_label: input.matchLabel ?? null,
      match_person_id: input.matchPersonId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,commitment_id' }
  )
  if (error) return { ok: false, error: error.message }

  await logEvent({
    user_id: user.id,
    event_type: 'companion_state',
    name: input.state,
    attrs: { commitment_id: input.commitmentId, snooze_until: snoozeUntil },
  })
  revalidatePath('/companion')
  return { ok: true }
}
