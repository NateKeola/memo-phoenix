import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMinerState } from '@/lib/miner/state'
import { isGithubDispatchConfigured, triggerMinerWorkflow } from '@/lib/miner/dispatch'
import { logEvent } from '@/lib/telemetry'

export const runtime = 'nodejs'

// Headless background mining (Phase 2 follow-up Task C). A scheduled sweep (Vercel
// Cron, see vercel.json) that mines for any user whose accumulated unmined-capture
// count is at or over the auto-run threshold, even with no tab open. It does NOT
// run a long mine inline in this short-lived function: it kicks off the GitHub
// Action per over-threshold user (the Action has no tight timeout) via
// repository_dispatch, recorded as an auto run.
//
// Safety: it only dispatches when shouldAutoRun is true (no active run + over
// threshold), and the Action's CLI takes the miner_runs lock (mineWithLock), so a
// cron-triggered mine can never collide with an in-app run.
//
// Gating: this is a system job, not a user request. It is gated by CRON_SECRET
// (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the env var is set).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    // Refuse to run unguarded. Set CRON_SECRET in the Vercel project to enable.
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 })
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // The headless path runs through the GitHub Action; without dispatch config there
  // is nowhere to send the work, so skip cleanly (in-app auto-run still covers it).
  if (!isGithubDispatchConfigured()) {
    return NextResponse.json({
      ok: true,
      skipped: 'github dispatch not configured (set GITHUB_DISPATCH_TOKEN + GITHUB_REPO)',
    })
  }

  const admin = createAdminClient()

  // Enumerate the beta users (small: a handful). One page is plenty.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (listErr) {
    console.error('[cron/miner-sweep] listUsers:', listErr.message)
    return NextResponse.json({ error: 'could not list users' }, { status: 500 })
  }
  const users = list?.users ?? []

  const triggered: string[] = []
  let checked = 0
  for (const u of users) {
    checked++
    try {
      // getMinerState scopes every query by user_id, so the service-role admin
      // client reads exactly this user's state (no cross-user bleed).
      const state = await getMinerState(admin, u.id)
      if (!state.shouldAutoRun) continue
      await triggerMinerWorkflow(u.id, 'auto')
      triggered.push(u.id)
      await logEvent({
        user_id: u.id,
        event_type: 'miner_run_triggered',
        name: 'cron',
        attrs: { trigger: 'auto', source: 'cron', new_captures: state.newCaptures, threshold: state.threshold },
      })
    } catch (e) {
      // one user's failure must not abort the sweep
      console.error('[cron/miner-sweep] user', u.id, e instanceof Error ? e.message : e)
    }
  }

  return NextResponse.json({ ok: true, checked, triggered })
}
