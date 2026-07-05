'use server'

import { redirect } from 'next/navigation'
import { requireAllowedUser } from '@/lib/auth/guard'
import { writeCapture } from '@/lib/captures'
import { logObs, obsError } from '@/lib/observability'

export async function addTextCapture(formData: FormData): Promise<void> {
  const body = String(formData.get('body') ?? '').trim()
  const routingHint = String(formData.get('routing_hint') ?? '').trim() || null

  if (!body) {
    redirect('/capture/text?error=' + encodeURIComponent('Capture cannot be empty'))
  }

  const { supabase, user } = await requireAllowedUser()

  try {
    await writeCapture(supabase, user.id, { mode: 'text', modality: 'text', body, routingHint })
  } catch (e) {
    // surface a clear form error (e.g. the too-large guard) rather than a crash
    await logObs({ subsystem: 'capture_text', event: 'error', status: 'error', userId: user.id, ...obsError(e), meta: { chars: body.length } })
    const msg = e instanceof Error ? e.message.replace(/^\[capture\]\s*/, '') : String(e)
    redirect('/capture/text?error=' + encodeURIComponent(msg))
  }
  await logObs({ subsystem: 'capture_text', event: 'ok', status: 'ok', userId: user.id, meta: { chars: body.length } })
  redirect('/capture/text?ok=1')
}
