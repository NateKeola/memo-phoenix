'use server'

import { redirect } from 'next/navigation'
import { requireAllowedUser } from '@/lib/auth/guard'
import { writeCapture } from '@/lib/captures'

export async function addTextCapture(formData: FormData): Promise<void> {
  const body = String(formData.get('body') ?? '').trim()
  const routingHint = String(formData.get('routing_hint') ?? '').trim() || null

  if (!body) {
    redirect('/capture/text?error=' + encodeURIComponent('Capture cannot be empty'))
  }

  const { supabase, user } = await requireAllowedUser()

  await writeCapture(supabase, user.id, { mode: 'text', modality: 'text', body, routingHint })
  redirect('/capture/text?ok=1')
}
