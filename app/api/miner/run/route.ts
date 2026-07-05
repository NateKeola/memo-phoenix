import { NextResponse, type NextRequest } from 'next/server'
import { authorizeApiUser } from '@/lib/auth/guard'
import { isOperator } from '@/lib/auth/operator'
import { mineWithLock } from '@memo/miner-core'
import { createAdminClient } from '@/lib/supabase/admin'
import { isGithubDispatchConfigured, triggerMinerWorkflow } from '@/lib/miner/dispatch'
import { getMinerState } from '@/lib/miner/state'
import { logEvent } from '@/lib/telemetry'
import { logObs } from '@/lib/observability'

export const runtime = 'nodejs'
// 300s so the app deploys on any plan. Real mines of a grown corpus take 13 to 22
// minutes (measured live), so the route sizes the WORK and only runs a mine inline
// when the corpus is tiny (a brand-new user's onboarding); everything bigger is
// dispatched to the GitHub Action (no timeout). When dispatch is not configured the
// route says so honestly (status 'needs_offload') instead of starting a doomed
// inline run that a timeout kills into a zombie, which is exactly what happened to
// every in-app mine of the real corpus before this change.
export const maxDuration = 300

// A corpus at or under this many captures mines inline in well under the ceiling
// (the onboarding first-mine case: one conversation). Above it, the work goes to
// the Action. Env-tunable for local dev (MINER_INLINE_MAX_CAPTURES; set high on a
// machine with no timeout).
const INLINE_MAX_CAPTURES = Number(process.env.MINER_INLINE_MAX_CAPTURES) || 6

export async function POST(request: NextRequest) {
  const auth = await authorizeApiUser()
  if ('error' in auth) return auth.error
  const { supabase, user } = auth

  const body = (await request.json().catch(() => ({}))) as { userId?: string; trigger?: string }
  // A user mines their OWN graph. Only the operator may target another user_id.
  const targetUserId = body.userId && isOperator(user) ? body.userId : user.id
  const trigger = typeof body.trigger === 'string' ? body.trigger : 'manual'

  // State reads must see the TARGET user's rows. The request's RLS client only
  // sees the caller's own rows, so an operator-targeted run uses the admin client
  // (service role, explicitly user-scoped inside getMinerState).
  const stateClient = targetUserId === user.id ? supabase : createAdminClient()
  const state = await getMinerState(stateClient, targetUserId)

  // Auto-run is authoritative server-side: a trigger='auto' request only proceeds
  // when there is genuinely pending work (threshold crossed, or corrections filed)
  // and no live run. Manual runs always proceed (the user explicitly asked). The
  // concurrency lock below is the second line against double-starts.
  if (trigger === 'auto' && !state.shouldAutoRun) {
    return NextResponse.json({
      status: 'skipped',
      reason: 'below_threshold',
      newCaptures: state.newCaptures,
      pendingCorrections: state.pendingCorrections,
      threshold: state.threshold,
    })
  }

  // Size the work. Total corpus size decides where the mine can safely run: the
  // measured cost is minutes per capture-with-passes, so anything beyond a tiny
  // first corpus exceeds the 300s ceiling regardless of trigger.
  const { count: totalCaptures } = await stateClient
    .from('captures')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', targetUserId)
  const corpus = totalCaptures ?? 0
  // MINER_USE_GITHUB_ACTION forces even tiny runs off-machine, but only when
  // dispatch is actually configured; the flag without config must not dead-end a
  // brand-new user's 1-capture onboarding mine into needs_offload.
  const forceOffload = process.env.MINER_USE_GITHUB_ACTION === '1' && isGithubDispatchConfigured()
  const inlineSafe = corpus <= INLINE_MAX_CAPTURES && !forceOffload

  if (!inlineSafe) {
    if (isGithubDispatchConfigured()) {
      try {
        await triggerMinerWorkflow(targetUserId, trigger)
        await logEvent({
          user_id: targetUserId,
          event_type: 'miner_run_triggered',
          name: 'github',
          attrs: { trigger, corpus, pending_corrections: state.pendingCorrections },
        })
        return NextResponse.json({ status: 'dispatched', runtime: 'github' })
      } catch (e) {
        // Do NOT fall through to a doomed inline run: report the dispatch failure.
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[miner/run] dispatch failed:', msg)
        await logObs({ subsystem: 'miner', event: 'dispatch_error', status: 'error', userId: targetUserId, errorMessage: msg, meta: { trigger } })
        return NextResponse.json({ status: 'error', error: `off-machine dispatch failed: ${msg}` }, { status: 502 })
      }
    }
    // No dispatch configured and the corpus is too big for the serverless window.
    await logEvent({
      user_id: targetUserId,
      event_type: 'miner_run_triggered',
      name: 'needs_offload',
      attrs: { trigger, corpus },
    })
    return NextResponse.json({
      status: 'needs_offload',
      corpus,
      hint:
        'This update is too large to run inside the app window. Configure the off-machine runner ' +
        '(GITHUB_DISPATCH_TOKEN + GITHUB_REPO in the deployment env) or run the miner Action manually.',
    })
  }

  await logEvent({
    user_id: targetUserId,
    event_type: 'miner_run_triggered',
    name: 'vercel',
    attrs: { trigger, corpus },
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
