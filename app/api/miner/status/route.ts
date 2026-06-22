import { NextResponse } from 'next/server'
import { authorizeApiUser } from '@/lib/auth/guard'

export const runtime = 'nodejs'

// The "building your memory" poller reads the user's latest miner run. RLS-scoped
// (the SELECT policy on miner_runs is user_id = auth.uid()), so a user only ever
// sees their own runs.
export async function GET() {
  const auth = await authorizeApiUser()
  if ('error' in auth) return auth.error
  const { supabase, user } = auth

  const { data } = await supabase
    .from('miner_runs')
    .select('id, status, trigger, runtime, started_at, ended_at, summary, error')
    .eq('user_id', user.id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return NextResponse.json({ status: 'none' })
  return NextResponse.json(data)
}
