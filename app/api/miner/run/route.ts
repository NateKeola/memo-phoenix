import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isOperator } from '@/lib/auth/operator'
import { mineWithLock } from '@memo/miner-core'
import { isGithubDispatchConfigured, triggerMinerWorkflow } from '@/lib/miner/dispatch'
import { logEvent } from '@/lib/telemetry'

export const runtime = 'nodejs'
// Vercel Pro + Fluid Compute ceiling. A full recompute is ~8 min today; this gives
// headroom so onboarding completes without a serverless timeout. If a graph ever
// outgrows it, set MINER_USE_GITHUB_ACTION=1 to offload to the Action instead.
export const maxDuration = 800

// Triggers a miner run for a user. Primary path: run it INLINE here on Vercel Pro.
// The concurrency lock (miner_runs partial unique index, via mineWithLock) makes a
// duplicate call a no-op ('already_running'), so a remount or double-click cannot
// start a colliding mine.
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as { userId?: string; trigger?: string }
  // A user mines their OWN graph. Only the operator may target another user_id.
  const targetUserId = body.userId && isOperator(user) ? body.userId : user.id
  const trigger = typeof body.trigger === 'string' ? body.trigger : 'manual'

  // Offload to the GitHub Action when explicitly configured (survives a closed tab
  // and any ceiling). The Action's CLI creates and owns the miner_runs row.
  if (process.env.MINER_USE_GITHUB_ACTION === '1' && isGithubDispatchConfigured()) {
    try {
      await triggerMinerWorkflow(targetUserId, trigger)
      await logEvent({
        user_id: targetUserId,
        event_type: 'miner_run_triggered',
        name: 'github',
        attrs: { trigger },
      })
      return NextResponse.json({ status: 'dispatched', runtime: 'github' })
    } catch (e) {
      console.error('[miner/run] dispatch failed, running inline:', e)
      // fall through to inline
    }
  }

  await logEvent({
    user_id: targetUserId,
    event_type: 'miner_run_triggered',
    name: 'vercel',
    attrs: { trigger },
  })
  try {
    const result = await mineWithLock(targetUserId, { trigger, runtime: 'vercel' })
    return NextResponse.json(result, { status: result.status === 'error' ? 500 : 200 })
  } catch (e) {
    return NextResponse.json(
      { status: 'error', error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
