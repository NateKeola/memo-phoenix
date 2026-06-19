'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { logEvent } from '@/lib/telemetry'

// Corrections write to the append-only `corrections` table ONLY. They never touch
// canonical_people. The miner reads corrections on its next run and applies the
// rename/merge during recompute, so the fix survives the full recompute.

export type ActionResult = { ok: boolean; error?: string }

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Rename a person: the miner relabels every mention of from_label to to_label.
export async function renamePerson(input: {
  personId: string
  fromLabel: string
  toLabel: string
}): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'unauthorized' }

  const from = (input.fromLabel ?? '').trim()
  const to = (input.toLabel ?? '').trim()
  if (!to) return { ok: false, error: 'a new name is required' }
  if (norm(to) === norm(from)) return { ok: false, error: 'that is already the name' }

  const { error } = await supabase.from('corrections').insert({
    user_id: user.id,
    kind: 'rename_person',
    payload: { person_id: input.personId, from_label: from, to_label: to },
  })
  if (error) return { ok: false, error: error.message }

  await logEvent({
    user_id: user.id,
    event_type: 'correction',
    name: 'rename_person',
    attrs: { person_id: input.personId, from_label: from, to_label: to },
  })
  revalidatePath('/people')
  revalidatePath(`/people/${input.personId}`)
  return { ok: true }
}

// Merge two people: the miner collapses from_label onto into_label (the survivor),
// unioning provenance and retiring the stale row.
export async function mergePeople(input: {
  fromId: string
  fromLabel: string
  intoId: string
  intoLabel: string
}): Promise<ActionResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'unauthorized' }

  const fromLabel = (input.fromLabel ?? '').trim()
  const intoLabel = (input.intoLabel ?? '').trim()
  if (!fromLabel || !intoLabel) return { ok: false, error: 'both people are required' }
  if (input.fromId === input.intoId || norm(fromLabel) === norm(intoLabel)) {
    return { ok: false, error: 'pick two different people' }
  }

  const { error } = await supabase.from('corrections').insert({
    user_id: user.id,
    kind: 'merge_people',
    payload: {
      from_id: input.fromId,
      from_label: fromLabel,
      into_id: input.intoId,
      into_label: intoLabel,
    },
  })
  if (error) return { ok: false, error: error.message }

  await logEvent({
    user_id: user.id,
    event_type: 'correction',
    name: 'merge_people',
    attrs: { from_id: input.fromId, from_label: fromLabel, into_id: input.intoId, into_label: intoLabel },
  })
  revalidatePath('/people')
  revalidatePath(`/people/${input.fromId}`)
  revalidatePath(`/people/${input.intoId}`)
  return { ok: true }
}
