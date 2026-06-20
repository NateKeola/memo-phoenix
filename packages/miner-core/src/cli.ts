import { loadEnv } from './env'

// Entry point for `npm run miner`. Runs a full recompute for one user under the
// concurrency lock (so a local/Action CLI run and a Vercel route run cannot
// collide). The target user is MEMO_USER_ID; the GitHub Action fallback sets it
// per-user via workflow_dispatch / repository_dispatch input.
async function main(): Promise<void> {
  loadEnv()
  const { requireUserId } = await import('./config')
  const { mineWithLock } = await import('./run')

  const userId = requireUserId()
  const trigger = process.env.MINER_TRIGGER || 'cli'
  const runtime = process.env.MINER_RUNTIME || 'local'
  console.log(`[miner] starting full recompute for user ${userId} (trigger=${trigger}, runtime=${runtime})`)

  const result = await mineWithLock(userId, { trigger, runtime })
  if (result.status === 'already_running') {
    console.log('[miner] another run is already active for this user; skipping.')
    return
  }
  if (result.status === 'error') {
    throw new Error(result.error)
  }

  const summary = result.summary
  console.log(
    `[miner] done in ${summary.durationMs}ms: ${summary.captures} captures, ` +
      `${summary.extracted} newly extracted, ${summary.rawInserted} raw rows inserted`
  )
  for (const p of summary.passes) {
    const note = p.skipped
      ? 'skipped (input unchanged)'
      : `rows=${p.rows} inserted=${p.inserted} updated=${p.updated} unchanged=${p.unchanged} batches=${p.batches}`
    console.log(`  - ${p.table}: ${note}`)
  }
}

main().catch((err) => {
  console.error('[miner] failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
