import { NextResponse } from 'next/server'
import { authorizeApiUser } from '@/lib/auth/guard'
import { isRunStale } from '@memo/miner-core'

export const runtime = 'nodejs'

// The "building your memory" poller reads the user's latest miner run. RLS-scoped
// (the SELECT policy on miner_runs is user_id = auth.uid()), so a user only ever
// sees their own runs.
//
// The status returned is the EFFECTIVE status: a 'running' row whose heartbeat has
// been silent past the staleness threshold is reported as 'stalled' (the process
// was killed, typically a serverless timeout), so the UI can say so plainly
// instead of showing an endless in-progress state. Read-only: the row itself is
// reclaimed by the next run start (mineWithLock), not by this GET.
export async function GET() {
  const auth = await authorizeApiUser()
  if ('error' in auth) return auth.error
  const { supabase, user } = auth

  const { data } = await supabase
    .from('miner_runs')
    .select('id, status, trigger, runtime, started_at, ended_at, summary, error, heartbeat_at, stage')
    .eq('user_id', user.id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data) return NextResponse.json({ status: 'none' })

  const row = data as {
    status: string
    started_at: string
    heartbeat_at?: string | null
    stage?: string | null
  } & Record<string, unknown>
  const stalled =
    row.status === 'running' &&
    isRunStale({ started_at: row.started_at, heartbeat_at: row.heartbeat_at ?? null }, Date.now())
  return NextResponse.json({ ...row, status: stalled ? 'stalled' : row.status })
}
