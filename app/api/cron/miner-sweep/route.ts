import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAllowed } from '@/lib/auth/guard'
import { getMinerState } from '@/lib/miner/state'
import { isGithubDispatchConfigured, triggerMinerWorkflow } from '@/lib/miner/dispatch'
import { logEvent } from '@/lib/telemetry'

export const runtime = 'nodejs'

// The DAILY mining trigger (one of exactly two; the other is the manual "Run now"
// button). A once-a-day Vercel Cron sweep (vercel.json, "0 8 * * *", within the
// Hobby daily-cron limit) that mines ONLY users whose accumulated unmined-capture
// count is at or over the auto-run threshold, skipping everyone with nothing new.
// It does NOT run a long mine inline in this short-lived function: it kicks off the
// GitHub Action per over-threshold user (the Action has no tight timeout) via
// repository_dispatch, recorded as an auto run. There is no fire-on-app-use trigger.
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
    // Sweep ONLY allowlisted users (operator + active invites). auth.users also
    // holds test residue (the inc-harness-* clone accounts, which have captures
    // and no successful runs); without this filter, configuring the cron would
    // dispatch a real model-billed mine for every one of them, every day.
    if (!(await isAllowed({ id: u.id, email: u.email ?? undefined }))) continue
    checked++
    try {
      // getMinerState scopes every query by user_id, so the service-role admin
      // client reads exactly this user's state (no cross-user bleed). A stalled
      // zombie run no longer counts as active (heartbeat-aware), so it cannot
      // silently suppress this sweep; and pending corrections count as work, so a
      // filed rename/merge gets applied by the next sweep instead of waiting for
      // unrelated captures to accumulate.
      const state = await getMinerState(admin, u.id)
      const dispatched = state.shouldAutoRun
      if (dispatched) {
        await triggerMinerWorkflow(u.id, 'auto')
        triggered.push(u.id)
      }
      // Heartbeat: one event per user per sweep, EVEN WHEN NOTHING IS DISPATCHED.
      // Before this, a sweep that did nothing left no trace anywhere, so "the cron
      // is dead" and "nothing was over threshold" were indistinguishable (the
      // audit could not tell whether the cron had ever fired).
      await logEvent({
        user_id: u.id,
        event_type: 'cron_sweep',
        name: dispatched ? 'dispatched' : 'skipped',
        attrs: {
          new_captures: state.newCaptures,
          pending_corrections: state.pendingCorrections,
          threshold: state.threshold,
          active_run: Boolean(state.active),
        },
      })
    } catch (e) {
      // one user's failure must not abort the sweep
      console.error('[cron/miner-sweep] user', u.id, e instanceof Error ? e.message : e)
      await logEvent({
        user_id: u.id,
        event_type: 'cron_sweep',
        name: 'error',
        attrs: { error: e instanceof Error ? e.message.slice(0, 300) : String(e) },
      })
    }
  }

  return NextResponse.json({ ok: true, checked, triggered })
}
