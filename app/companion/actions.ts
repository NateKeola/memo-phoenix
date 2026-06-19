'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logEvent } from '@/lib/telemetry'
import { getValidAccessToken } from '@/lib/google/connection'
import { sendGmail } from '@/lib/google/gmail'
import { createCalendarEvent } from '@/lib/google/calendar'
import { draftCalendar, draftEmail } from '@/lib/companion/draft'

// SAFETY BOUNDARY (spec §9, harness doctrine): drafting and sending are SEPARATE
// actions. The draft actions call the model but never send. The send/create
// actions perform the external side effect and NEVER call the model; they are
// gated in code behind an explicit confirm flag and a live connection. There is no
// path from model output to a sent email without the user invoking a send action.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { supabase, user }
}

type CommitmentContext = {
  label: string
  due: string | null
  personName: string | null
  workOrPersonal: string | null
}

function s(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

async function loadCommitment(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  commitmentId: string
): Promise<CommitmentContext | null> {
  const { data } = await supabase
    .from('canonical_commitments')
    .select('label, data')
    .eq('user_id', userId)
    .eq('id', commitmentId)
    .is('valid_to', null)
    .maybeSingle()
  if (!data) return null
  const row = data as { label: string | null; data: Record<string, unknown> | null }
  const d = row.data ?? {}
  let personName: string | null = null
  let workOrPersonal: string | null = s(d.work_or_personal)
  const pid = s(d.person_id)
  if (pid) {
    const { data: p } = await supabase
      .from('canonical_people')
      .select('label, data')
      .eq('user_id', userId)
      .eq('id', pid)
      .maybeSingle()
    if (p) {
      personName = (p as { label: string | null }).label
      workOrPersonal = workOrPersonal ?? s((p as { data: Record<string, unknown> | null }).data?.work_or_personal as unknown)
    }
  }
  return { label: row.label ?? 'a follow-up', due: s(d.due), personName, workOrPersonal }
}

// ---- commitment state (overlay; never edits canonical) ----------------------

export type StateResult = { ok: boolean; error?: string }

export async function setCommitmentState(input: {
  commitmentId: string
  state: 'open' | 'done' | 'snoozed' | 'dismissed'
  snoozeDays?: number
}): Promise<StateResult> {
  const { supabase, user } = await requireUser()
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

// ---- draft (model drafts content; does NOT send) ----------------------------

export type DraftResult =
  | { ok: true; kind: 'email'; draft: { subject: string; body: string } }
  | { ok: true; kind: 'calendar'; draft: { title: string; durationMinutes: number; description: string } }
  | { ok: false; error: string }

export async function draftEmailAction(input: { commitmentId: string }): Promise<DraftResult> {
  const { supabase, user } = await requireUser()
  if (!user) return { ok: false, error: 'unauthorized' }
  const ctx = await loadCommitment(supabase, user.id, input.commitmentId)
  if (!ctx) return { ok: false, error: 'commitment not found' }
  const userName = process.env.MEMO_USER_NAME || user.email?.split('@')[0] || 'me'
  try {
    const draft = await draftEmail({
      commitment: ctx.label,
      personName: ctx.personName,
      workOrPersonal: ctx.workOrPersonal,
      userName,
      due: ctx.due,
    })
    await logEvent({
      user_id: user.id,
      event_type: 'companion_draft',
      name: 'email',
      attrs: { commitment_id: input.commitmentId },
    })
    return { ok: true, kind: 'email', draft }
  } catch (err) {
    return { ok: false, error: draftError(err) }
  }
}

export async function draftCalendarAction(input: { commitmentId: string }): Promise<DraftResult> {
  const { supabase, user } = await requireUser()
  if (!user) return { ok: false, error: 'unauthorized' }
  const ctx = await loadCommitment(supabase, user.id, input.commitmentId)
  if (!ctx) return { ok: false, error: 'commitment not found' }
  const userName = process.env.MEMO_USER_NAME || user.email?.split('@')[0] || 'me'
  try {
    const draft = await draftCalendar({
      commitment: ctx.label,
      personName: ctx.personName,
      workOrPersonal: ctx.workOrPersonal,
      userName,
      due: ctx.due,
    })
    await logEvent({
      user_id: user.id,
      event_type: 'companion_draft',
      name: 'calendar',
      attrs: { commitment_id: input.commitmentId },
    })
    return { ok: true, kind: 'calendar', draft }
  } catch (err) {
    return { ok: false, error: draftError(err) }
  }
}

function draftError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const status = (err as { status?: number })?.status
  if (status === 429 || /usage limit|rate limit|overloaded/i.test(msg)) {
    return 'The model is unavailable right now (usage limit). Try drafting again later.'
  }
  if (/ANTHROPIC_API_KEY/.test(msg)) return 'The drafting model is not configured on the server.'
  return 'Could not draft this. Please try again.'
}

// ---- send / create (CODE-GATED external side effect; NO model call) ----------

export type SendResult = { ok: boolean; error?: string; needsConnect?: boolean; id?: string }

async function recordAction(
  userId: string,
  row: { kind: string; status: string; commitmentId?: string; target?: string; payload: Record<string, unknown> }
) {
  const admin = createAdminClient()
  await admin.from('companion_actions').insert({
    user_id: userId,
    kind: row.kind,
    status: row.status,
    commitment_id: row.commitmentId ?? null,
    target: row.target ?? null,
    payload: row.payload,
  })
}

export async function sendEmailAction(input: {
  commitmentId?: string
  to: string
  subject: string
  body: string
  confirm: boolean
}): Promise<SendResult> {
  const { user } = await requireUser()
  if (!user) return { ok: false, error: 'unauthorized' }
  // The gate: nothing sends without an explicit confirmation.
  if (input.confirm !== true) return { ok: false, error: 'confirmation required' }
  const to = (input.to ?? '').trim()
  if (!EMAIL_RE.test(to)) return { ok: false, error: 'a valid recipient email is required' }
  if (!input.subject?.trim() && !input.body?.trim()) return { ok: false, error: 'the message is empty' }

  let accessToken: string
  try {
    accessToken = await getValidAccessToken(user.id)
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_CONNECTED') return { ok: false, needsConnect: true, error: 'Gmail is not connected.' }
    return { ok: false, error: 'Could not reach your Google connection.' }
  }

  try {
    const sent = await sendGmail(accessToken, { to, subject: input.subject ?? '', body: input.body ?? '' })
    await recordAction(user.id, {
      kind: 'email',
      status: 'sent',
      commitmentId: input.commitmentId,
      target: to,
      payload: { subject: input.subject },
    })
    await logEvent({
      user_id: user.id,
      event_type: 'companion_send',
      name: 'email',
      attrs: { commitment_id: input.commitmentId ?? null, status: 'sent' },
    })
    return { ok: true, id: sent.id }
  } catch (err) {
    await recordAction(user.id, { kind: 'email', status: 'failed', commitmentId: input.commitmentId, target: to, payload: { subject: input.subject } })
    await logEvent({ user_id: user.id, event_type: 'companion_send', name: 'email', attrs: { status: 'failed' } })
    return { ok: false, error: 'The send failed. Please try again.' }
  }
}

export async function createEventAction(input: {
  commitmentId?: string
  title: string
  startISO: string
  durationMinutes: number
  attendee?: string
  description?: string
  confirm: boolean
}): Promise<SendResult> {
  const { user } = await requireUser()
  if (!user) return { ok: false, error: 'unauthorized' }
  if (input.confirm !== true) return { ok: false, error: 'confirmation required' }
  if (!input.title?.trim()) return { ok: false, error: 'a title is required' }
  const start = Date.parse(input.startISO)
  if (!Number.isFinite(start)) return { ok: false, error: 'a valid start time is required' }
  const attendee = (input.attendee ?? '').trim()
  if (attendee && !EMAIL_RE.test(attendee)) return { ok: false, error: 'the attendee email is invalid' }
  const mins = Number.isFinite(input.durationMinutes) && input.durationMinutes > 0 ? input.durationMinutes : 30
  const endISO = new Date(start + mins * 60_000).toISOString()

  let accessToken: string
  try {
    accessToken = await getValidAccessToken(user.id)
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_CONNECTED') return { ok: false, needsConnect: true, error: 'Calendar is not connected.' }
    return { ok: false, error: 'Could not reach your Google connection.' }
  }

  try {
    const created = await createCalendarEvent(accessToken, {
      title: input.title,
      startISO: new Date(start).toISOString(),
      endISO,
      attendee: attendee || undefined,
      description: input.description,
    })
    await recordAction(user.id, {
      kind: 'calendar',
      status: 'created',
      commitmentId: input.commitmentId,
      target: attendee || undefined,
      payload: { title: input.title, startISO: new Date(start).toISOString() },
    })
    await logEvent({
      user_id: user.id,
      event_type: 'companion_send',
      name: 'calendar',
      attrs: { commitment_id: input.commitmentId ?? null, status: 'created' },
    })
    return { ok: true, id: created.id }
  } catch (err) {
    await recordAction(user.id, { kind: 'calendar', status: 'failed', commitmentId: input.commitmentId, payload: { title: input.title } })
    await logEvent({ user_id: user.id, event_type: 'companion_send', name: 'calendar', attrs: { status: 'failed' } })
    return { ok: false, error: 'Creating the event failed. Please try again.' }
  }
}
