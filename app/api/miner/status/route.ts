import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

// The "building your memory" poller reads the user's latest miner run. RLS-scoped
// (the SELECT policy on miner_runs is user_id = auth.uid()), so a user only ever
// sees their own runs.
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

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
