// API-route + admin-gate + agent-context isolation, by source inspection.
//
// The DB is the hard data boundary (proven live by check-table-isolation +
// check-rls: even a buggy route cannot cross RLS). This guard proves the FIRST line
// of defense at the code level, which needs no running server (so the operator can
// run it anywhere): every API route authenticates before touching user data, an id
// cannot be forged to reach another user, the observability console is admin-only,
// and the agent-context builders (interview brief, companion, daily brief) read
// through the caller's RLS-scoped client, never a cross-user/admin read.
//
// Run: node scripts/check-api-isolation.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`  ok   ${n}`) }
const bad = (n, d = '') => { fail++; console.log(`  FAIL ${n} ${d}`) }
const check = (n, c, d = '') => (c ? ok(n) : bad(n, d))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

function walk(dir) {
  const out = []
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e)
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) out.push(...walk(rel))
    else if (e === 'route.ts') out.push(rel)
  }
  return out
}

// The auth gates a route may legitimately use, and the routes exempt from user-auth
// (they gate differently, by design).
const GATES = ['authorizeApiUser', 'authorizeAction', 'requireAllowedUser']
const CRON_ROUTES = { 'app/api/cron/miner-sweep/route.ts': 'CRON_SECRET' } // system cron: shared-secret gated
const RECOVERY_ROUTES = { 'app/api/auth/recovery-session/route.ts': 'getUser' } // recovery bridge: session-gated

console.log('== every API route authenticates before touching user data ==')
const routes = walk('app/api').sort()
check(`found ${routes.length} API routes`, routes.length >= 10)
for (const r of routes) {
  const src = read(r)
  if (CRON_ROUTES[r]) {
    check(`${r} is CRON_SECRET-gated`, /CRON_SECRET/.test(src) && /(401|403|503)/.test(src))
    continue
  }
  if (RECOVERY_ROUTES[r]) {
    check(`${r} is session-gated (getUser)`, /getUser\(\)/.test(src))
    continue
  }
  const gate = GATES.find((g) => src.includes(g))
  if (!gate) { bad(`${r} has NO recognized auth gate`, 'add authorizeApiUser or classify it'); continue }
  // the gate must be called and its failure returned BEFORE the first user-data access
  const gateIdx = src.indexOf(gate + '(')
  // markers of a real data access CALL (with parens, so import mentions do not match)
  const dataIdx = Math.min(
    ...['.from(', 'mineWithLock(', 'createAdminClient(', 'getMinerState(', 'triggerMinerWorkflow('].map((m) => { const i = src.indexOf(m); return i < 0 ? Infinity : i })
  )
  const gatedEarly = gateIdx >= 0 && (dataIdx === Infinity || gateIdx < dataIdx)
  const returnsOnFail = /if \('error' in auth\) return auth\.error/.test(src) || /if \(!auth\.ok\)/.test(src) || /return auth\.error/.test(src)
  check(`${r} gates with ${gate} before any data access, returns on failure`, gatedEarly && returnsOnFail, `gateIdx=${gateIdx} dataIdx=${dataIdx} returns=${returnsOnFail}`)
}

console.log('\n== a forged user id cannot reach another user (miner/run) ==')
{
  const src = read('app/api/miner/run/route.ts')
  // targetUserId must fall back to the AUTHED user unless the caller is the operator
  const guarded = /isOperator\(user\)\s*\?\s*body\.userId\s*:\s*user\.id/.test(src) ||
    (/isOperator\(user\)/.test(src) && /:\s*user\.id/.test(src) && /body\.userId/.test(src))
  check('miner/run: body.userId is honored ONLY for the operator, else falls back to user.id', guarded)
  check('miner/run: never uses body.userId as the target without an isOperator check', !/targetUserId\s*=\s*body\.userId\b(?![^\n]*isOperator)/.test(src))
}

console.log('\n== the observability console is admin-only ==')
{
  const src = read('app/admin/observability/page.tsx')
  check('obs console requires isOperator and redirects a non-operator', /isOperator\(user\)/.test(src) && /redirect\(/.test(src))
  check('obs console cross-user read is service-role (admin client), gated by the isOperator check above', /createAdminClient\(\)/.test(src))
  // the /admin layer generally: the invite console + actions are operator-gated too
  const adminActions = read('app/admin/actions.ts')
  check('admin actions are operator-gated (isOperator)', /isOperator/.test(adminActions))
}

console.log('\n== agent context is built from the caller\'s own graph only ==')
{
  // The brief / companion / interview reads must go through the RLS-scoped client the
  // route was handed, never a cross-user or service-role read of user data.
  const briefing = read('lib/interview/briefing.ts')
  check('briefing.ts reads canonical via the passed (RLS) client, not the admin client', !/createAdminClient/.test(briefing) && /\.eq\('user_id'/.test(briefing))
  const today = read('lib/companion/today.ts')
  check('companion today.ts reads via the RLS client scoped by user_id, not the admin client', !/createAdminClient/.test(today) && /\.eq\('user_id'/.test(today))
  const start = read('app/api/interview/start/route.ts')
  // the interview brief is composed with the authed RLS supabase client
  check('interview/start composes the brief with the authed RLS client (not admin)', /compose(Brief|PersonBrief|TopicBrief)\(supabase/.test(start))
  check('interview/start does not build the brief from a cross-user/admin read', !/createAdminClient/.test(start))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
