import { loadEnv } from './env'

// Entry point for `npm run miner`. Runs a full recompute for the single user.
async function main(): Promise<void> {
  loadEnv()
  const { requireUserId } = await import('./config')
  const { mine } = await import('./run')

  const userId = requireUserId()
  const started = Date.now()
  console.log(`[miner] starting full recompute for user ${userId}`)

  const summary = await mine(userId, started)
  summary.durationMs = Date.now() - started

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
