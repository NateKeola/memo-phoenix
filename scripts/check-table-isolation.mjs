// Cross-user table isolation, DYNAMICALLY over every per-user table.
//
// check-multiuser covers a fixed representative set; this enumerates EVERY public
// table that has a user_id column (from pg_catalog, so new tables are auto-covered)
// and proves the data boundary against real live data:
//   - a brand-new user B (who owns nothing) reads ZERO rows from every table, so it
//     can never see another user's rows (the real user's data across most tables
//     makes this a concrete proof, not a vacuous one);
//   - an ANONYMOUS client reads zero from every table;
//   - B cannot forge a write for another user_id into a user-writable table (RLS
//     with_check), including the newer tables (user_profiles, event_tags), the
//     append-only ground truth policy is proven by check-rls + the read isolation;
//   - observability_events (nullable user_id: system/cron events) is invisible to B;
//   - the canonical_* tables that feed the interview brief / companion / daily brief
//     (agent context) are isolated, so no other user's context can bleed into B.
// Residue-free: B inserts nothing that survives (forged writes are denied); teardown
// deletes B and any stray forged rows.
//
// Run: node scripts/check-table-isolation.mjs
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '')
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const REF = process.env.SUPABASE_PROJECT_REF
const MGMT = process.env.SUPABASE_ACCESS_TOKEN
if (!URL || !ANON || !SERVICE || !REF || !MGMT) {
  console.error('need SUPABASE URL + ANON + SERVICE_ROLE + PROJECT_REF + ACCESS_TOKEN in .env.local')
  process.exit(2)
}
const HOST = URL.replace(/^https?:\/\//, '')

function reqTo(host, path, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body)
  const h = { ...headers }
  if (payload) h['content-length'] = Buffer.byteLength(payload)
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host, path, method, headers: h }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => { let d = null; try { d = t ? JSON.parse(t) : null } catch { d = t } resolve({ status: res.statusCode, data: d }) })
    })
    r.setTimeout(30000, () => r.destroy(new Error('timeout ' + path)))
    r.on('error', reject)
    if (payload) r.end(payload); else r.end()
  })
}
const mgmtSql = (query) => reqTo('api.supabase.com', `/v1/projects/${REF}/database/query`, { method: 'POST', headers: { authorization: `Bearer ${MGMT}`, 'content-type': 'application/json' }, body: { query } }).then((r) => r.data)
const rest = (method, path, { jwt, anonOnly, body, prefer } = {}) => {
  const headers = { apikey: ANON, 'content-type': 'application/json' }
  if (jwt) headers.authorization = `Bearer ${jwt}`
  else if (!anonOnly) headers.authorization = `Bearer ${ANON}`
  if (prefer) headers.prefer = prefer
  return reqTo(HOST, `/rest/v1/${path}`, { method, headers, body })
}
const svc = (method, path, body, prefer) => reqTo(HOST, `/rest/v1/${path}`, { method, headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) }, body })
const adminAuth = (method, path, body) => reqTo(HOST, `/auth/v1/${path}`, { method, headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' }, body })

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`  ok   ${n}`) }
const bad = (n, d = '') => { fail++; console.log(`  FAIL ${n} ${d}`) }
const check = (n, c, d = '') => (c ? ok(n) : bad(n, d))

const EMAIL_B = 'tableiso-b@securitytest.local'
const PASS_B = 'Tableiso-B-pw-2a9f7c1d'
const FORGE = '00000000-0000-4000-8000-00000f0f0f0f' // a non-existent "other" user_id to forge against
const arr = (d) => (Array.isArray(d) ? d : [])

async function findUser(email) {
  for (let p = 1; p <= 5; p++) {
    const r = await adminAuth('GET', `admin/users?page=${p}&per_page=200`)
    const u = (r.data?.users || []).find((x) => x.email === email)
    if (u) return u
    if ((r.data?.users || []).length < 200) break
  }
  return null
}
async function delUser(email) { const u = await findUser(email); if (u) await adminAuth('DELETE', `admin/users/${u.id}`) }

async function main() {
  console.log('project host:', HOST)

  // enumerate per-user tables from the live catalog (auto-covers new tables)
  const rows = await mgmtSql(`
    select c.relname as t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relkind='r'
      and exists (select 1 from information_schema.columns col
                  where col.table_schema='public' and col.table_name=c.relname and col.column_name='user_id')
    order by c.relname`)
  const tables = arr(rows).map((r) => r.t)
  console.log(`enumerated ${tables.length} per-user tables\n`)
  check('enumerated a plausible set of per-user tables', tables.length >= 20, `got ${tables.length}`)

  await delUser(EMAIL_B)
  const cb = await adminAuth('POST', 'admin/users', { email: EMAIL_B, password: PASS_B, email_confirm: true })
  const B = cb.data?.id
  check('created throwaway user B (owns nothing)', !!B)
  if (!B) return finish()
  const jwtB = (await reqTo(HOST, '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: { email: EMAIL_B, password: PASS_B } })).data?.access_token
  check('B signed in', !!jwtB)
  if (!jwtB) { await delUser(EMAIL_B); return finish() }

  // --- every per-user table: B sees ZERO, anon sees ZERO ---
  console.log('\n== every per-user table: a fresh user B and anon read ZERO rows ==')
  let tablesWithData = 0, bLeaks = 0, anonLeaks = 0
  for (const t of tables) {
    const total = await svc('GET', `${t}?select=user_id&limit=1`)
    if (arr(total.data).length > 0) tablesWithData++
    const bRes = await rest('GET', `${t}?select=user_id&limit=3`, { jwt: jwtB })
    const bRows = arr(bRes.data)
    if (bRows.length !== 0) { bLeaks++; bad(`${t}: B sees ${bRows.length} row(s) (LEAK)`, JSON.stringify(bRows).slice(0, 100)); continue }
    const aRes = await rest('GET', `${t}?select=user_id&limit=3`, { anonOnly: true })
    const aRows = arr(aRes.data)
    if (aRes.status < 300 && aRows.length !== 0) { anonLeaks++; bad(`${t}: anon sees ${aRows.length} row(s) (LEAK)`); continue }
  }
  check(`B reads 0 rows from ALL ${tables.length} per-user tables`, bLeaks === 0)
  check(`anon reads 0 rows from ALL ${tables.length} per-user tables`, anonLeaks === 0)
  console.log(`  (${tablesWithData}/${tables.length} tables currently hold real data, so the "0 for B" is a concrete isolation proof there)`)
  check('the proof is concrete (real data exists in most tables)', tablesWithData >= 10, `only ${tablesWithData} tables had data`)

  // --- observability: system (null user_id) events are invisible to an authed user ---
  const obsSys = await svc('GET', `observability_events?user_id=is.null&select=id&limit=1`)
  const bObs = await rest('GET', `observability_events?select=id&limit=3`, { jwt: jwtB })
  check('observability system (null-user) events are invisible to a normal user', arr(bObs.data).length === 0)
  console.log(`  (system/null-user obs events present: ${arr(obsSys.data).length > 0 ? 'yes' : 'none right now'})`)

  // --- agent context: the canonical_* tables that feed brief/companion/interview ---
  const agentTables = ['canonical_people', 'canonical_commitments', 'canonical_events', 'canonical_facts', 'canonical_relationships', 'insights']
  let agentLeak = 0
  for (const t of agentTables) { if (arr((await rest('GET', `${t}?select=user_id&limit=3`, { jwt: jwtB })).data).length !== 0) agentLeak++ }
  check('agent-context tables (canonical_*/insights) show B nothing (no cross-user brief bleed)', agentLeak === 0)

  // --- forged writes: B cannot insert a row for another user_id (user-writable tables) ---
  console.log('\n== forged cross-user writes are denied (RLS with_check) ==')
  const forgeCases = [
    { t: 'user_profiles', row: { user_id: FORGE, display_name: 'forged' } },
    { t: 'event_tags', row: { user_id: FORGE, event_id: FORGE, work_or_personal: 'work' } },
    { t: 'companion_state', row: { user_id: FORGE, commitment_id: FORGE, state: 'dismissed' } },
  ]
  for (const c of forgeCases) {
    const r = await rest('POST', c.t, { jwt: jwtB, body: [c.row], prefer: 'return=representation' })
    const created = r.status < 300 && arr(r.data).length > 0
    check(`B cannot forge a ${c.t} row for another user`, !created, `status ${r.status}`)
  }

  await teardown()
  finish()
}

async function teardown() {
  // remove any forged rows that somehow landed (defense; they should have been denied)
  for (const t of ['user_profiles', 'event_tags', 'companion_state']) await svc('DELETE', `${t}?user_id=eq.${FORGE}`)
  await delUser(EMAIL_B)
  const leftB = await findUser(EMAIL_B)
  check('throwaway user B removed (no residue)', !leftB)
}
function finish() { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail === 0 ? 0 : 1) }
main().catch((e) => { console.error(e); process.exit(1) })
