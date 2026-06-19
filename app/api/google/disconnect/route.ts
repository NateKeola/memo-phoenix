import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { disconnect } from '@/lib/google/connection'

export const runtime = 'nodejs'

// Remove the stored Google tokens for the signed-in user.
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url), { status: 303 })
  await disconnect(user.id)
  return NextResponse.redirect(new URL('/companion?google=disconnected', request.url), { status: 303 })
}
