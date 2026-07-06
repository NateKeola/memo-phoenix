// One-command smoke: run the deterministic health checks a fresh session (or CI, or
// the operator) can trust in a single step, and print exactly which live/human steps
// it can NOT automate so nothing reads as "covered" when it is not.
//
// What it runs (each exits non-zero on any failure; all are self-cleaning):
//   - check-rls          : every table RLS-forced + per-user policy (the security gate)
//   - check-multiuser    : two real users, cross-user isolation both directions
//   - check-invite       : invite allowlist admits/rejects, signups stay disabled
//   - check-obs-db       : observability store write -> read -> health rollup -> privacy
//
// What it CANNOT automate (human/live, same caveat as every PR):
//   - a real voice interview (mic + ElevenLabs WebSocket) end to end
//   - a real memo upload transcribed by ElevenLabs Scribe
//   - a real miner run (needs ANTHROPIC_API_KEY; off-machine via the Action)
//   These are the operator's acceptance checks; this harness proves the surrounding
//   deterministic layer (auth boundary, isolation, invites, observability store).
//
// Run: node scripts/smoke.mjs   (or: npm run smoke)
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const steps = [
  ['RLS boundary', 'check-rls.mjs'],
  ['multi-user isolation', 'check-multiuser.mjs'],
  ['invite allowlist', 'check-invite.mjs'],
  ['observability store', 'check-obs-db.mjs'],
  ['avatar + profile isolation', 'check-avatar-isolation.mjs'],
]

const results = []
for (const [label, file] of steps) {
  console.log(`\n=== ${label} (${file}) ===`)
  const r = spawnSync(process.execPath, [join(HERE, file)], { stdio: 'inherit' })
  results.push([label, r.status === 0])
}

console.log('\n================ smoke summary ================')
let failed = 0
for (const [label, ok] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed++
}
console.log('\nNOT automated here (operator acceptance): live voice interview, live')
console.log('Scribe memo upload, live miner run. See docs/flows/ for each path.')
console.log(failed === 0 ? '\nall deterministic checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
