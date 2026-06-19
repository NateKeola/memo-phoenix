'use server'

import { createClient } from '@/lib/supabase/server'
import { writeCapture } from '@/lib/captures'
import { parseTarget } from '@/lib/capture-target'
import { logEvent } from '@/lib/telemetry'

// Shared "add context" server action used by every surface (a person, a follow-up,
// a chat topic). It writes a normal append-only capture that carries a target, so
// the miner attaches the extracted context to the intended thing. It never edits
// canonical.

export type ContextResult = { ok: boolean; error?: string; id?: string }

export async function addContextNote(input: {
  body: string
  targetKind?: string
  targetId?: string
  source?: string // which surface this came from (person, follow_up, ...)
}): Promise<ContextResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'unauthorized' }

  const body = (input.body ?? '').trim()
  if (!body) return { ok: false, error: 'the note cannot be empty' }

  const target = parseTarget(input.targetKind, input.targetId)
  const { id } = await writeCapture(supabase, user.id, {
    mode: 'text',
    modality: 'text',
    body,
    targetKind: target?.kind ?? null,
    targetId: target?.id ?? null,
  })

  await logEvent({
    user_id: user.id,
    event_type: 'context_add',
    name: 'note',
    attrs: { source: input.source ?? null, target_kind: target?.kind ?? null, target_id: target?.id ?? null },
  })
  return { ok: true, id }
}
