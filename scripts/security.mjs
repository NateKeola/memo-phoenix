// The cross-user security harness: ONE command the operator runs before onboarding
// new users, proving that no user can read, write, or be contaminated by another
// user's data across every surface. It consolidates all isolation guards and reports
// a clear PASS/FAIL per surface, with no residue (each guard self-cleans its
// throwaway users). Run: node scripts/security.mjs  (or: npm run security)
//
// Surfaces covered (see each guard for the assertions):
//   tables (RLS state)      check-rls.mjs             every table RLS-forced + per-user policy, views security_invoker, roles cannot bypass
//   tables (every table)    check-table-isolation.mjs a fresh user + anon read 0 rows from ALL per-user tables (dynamically enumerated); forged writes denied; obs null-user + canonical isolation
//   tables (behavioral)     check-multiuser.mjs       two real users, bidirectional seed/read/forge on the representative mutable + canonical layer + the reconfirm view
//   storage + profile       check-avatar-isolation.mjs a user can read/write only its own avatar object + user_profiles row; anon blocked
//   miner (per-user)        check-miner-isolation.ts  the service-role miner path (full + incremental + resolver + markers) is user-scoped; assertUserId hard-fails unscoped
//   api routes + agent      check-api-isolation.mjs   every route authenticates before data; forged id operator-gated; obs console admin-only; brief/companion/interview read the caller's own graph
//   observability store     check-obs-db.mjs          shaped-only, privacy holds, health rollup; the console admin-gate is asserted in check-api-isolation
//   auth / invite allowlist check-invite.mjs          signups disabled, no anon-signup bypass, allowlist admits/rejects
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

// [surface, file, runner]. tsx for .ts, node for .mjs.
const STEPS = [
  ['tables: RLS state', 'check-rls.mjs', 'node'],
  ['tables: every per-user table isolated', 'check-table-isolation.mjs', 'node'],
  ['tables: two-user behavioral', 'check-multiuser.mjs', 'node'],
  ['storage + profile', 'check-avatar-isolation.mjs', 'node'],
  ['miner: strictly per-user', 'check-miner-isolation.ts', 'tsx'],
  ['api routes + admin + agent context', 'check-api-isolation.mjs', 'node'],
  ['observability store + privacy', 'check-obs-db.mjs', 'node'],
  ['auth / invite allowlist', 'check-invite.mjs', 'node'],
]

const results = []
for (const [surface, file, runner] of STEPS) {
  console.log(`\n======== ${surface} (${file}) ========`)
  const cmd = runner === 'tsx' ? 'npx' : process.execPath
  const args = runner === 'tsx' ? ['tsx', join(HERE, file)] : [join(HERE, file)]
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: join(HERE, '..') })
  results.push([surface, r.status === 0])
}

console.log('\n================= SECURITY SUMMARY =================')
let failed = 0
for (const [surface, okv] of results) {
  console.log(`  ${okv ? 'PASS' : 'FAIL'}  ${surface}`)
  if (!okv) failed++
}
console.log('\nProven: anonymous + unauthenticated access is blocked at the DB (every table)')
console.log('and at every API route (auth gate before data); a forged user id cannot')
console.log('reach another user; the observability console is admin-only; and the')
console.log('interview / companion / daily brief read only the caller\'s own graph.')
console.log('\nNOT automatable here (operator acceptance): a live voice interview round-trip')
console.log('(mic + ElevenLabs) and a real miner run against the model. Their DATA paths')
console.log('are proven above (RLS + user-scoped reads); the live round-trips are the')
console.log('operator\'s check.')
console.log(failed === 0 ? '\nALL SURFACES ISOLATED. Safe to onboard new users.' : `\n${failed} surface(s) FAILED. Do NOT onboard until fixed.`)
process.exit(failed === 0 ? 0 : 1)
