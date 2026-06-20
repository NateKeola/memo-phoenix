import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMinerState } from '@/lib/miner/state'

export const runtime = 'nodejs'

// The miner-control surface reads everything it needs in one call: the active run,
// the run ledger, and the "new context since last mine" measure that drives the
// progress-toward-auto-run bar. RLS-scoped (miner_runs + captures SELECT policies
// are user_id = auth.uid()), so a user only ever sees their own state.
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const state = await getMinerState(supabase, user.id)
  return NextResponse.json(state)
}
