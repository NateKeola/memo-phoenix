// B1: live two-user isolation test (the security gate).
//
// Proves that two real users cannot read, write, or infer each other's rows
// through ANY path: direct table queries, the canonical layer behind search/chat
// and the contact sheet, the companion overlay, and the reconfirm view. Creates
// two clearly-marked test users, populates each with distinct deletable data,
// asserts zero cross-user access as each user (and as an anonymous client), then
// deletes the users and their data. Leaves NO residue: it inserts only into
// mutable tables (canonical_*, companion_state), never the append-only ground
// truth (captures/raw/corrections), so teardown is complete.
//
// Zero dependencies: uses node:https directly (global fetch and @supabase/supabase-js
// both misbehave in some local environments). Re-runnable: it cleans up any prior
// run's test users first.
//
// Run: node scripts/check-multiuser.mjs    (needs SUPABASE_SERVICE_ROLE_KEY +
//                                            NEXT_PUBLIC_SUPABASE_URL/ANON_KEY in .env.local)
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
if (!URL || !ANON || !SERVICE) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
  process.exit(2)
}
const HOST = URL.replace(/^https?:\/\//, '')

// --- node:https request helper ---------------------------------------------
function req(method, path, { apikey, jwt, body, prefer } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers = { 'content-type': 'application/json' }
  if (apikey) headers.apikey = apikey
  if (jwt) headers.authorization = `Bearer ${jwt}`
  if (prefer) headers.prefer = prefer
  if (payload) headers['content-length'] = Buffer.byteLength(payload)
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host: HOST, path, method, headers }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => {
        let data = null
        try { data = t ? JSON.parse(t) : null } catch { data = t }
        resolve({ status: res.statusCode, data })
      })
    })
    r.setTimeout(30000, () => r.destroy(new Error('timeout ' + path)))
    r.on('error', reject)
    if (payload) r.end(payload)
    else r.end()
  })
}

// service-role REST (bypasses RLS) for setup/teardown
const svc = (method, path, body, prefer) => req(method, `/rest/v1/${path}`, { apikey: SERVICE, jwt: SERVICE, body, prefer })
// a signed-in user's RLS-scoped REST
const asUser = (jwt, method, path, body, prefer) => req(method, `/rest/v1/${path}`, { apikey: ANON, jwt, body, prefer })
// anonymous (no JWT): anon apikey only
const asAnon = (method, path) => req(method, `/rest/v1/${path}`, { apikey: ANON })
// admin auth API (service role)
const adminAuth = (method, path, body) => req(method, `/auth/v1/${path}`, { apikey: SERVICE, jwt: SERVICE, body })

let pass = 0, fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

const EMAIL_A = 'b1-sectest-a@securitytest.local'
const EMAIL_B = 'b1-sectest-b@securitytest.local'
const PASS_A = 'Sectest-A-pw-9f3a2b1c'
const PASS_B = 'Sectest-B-pw-7d8e4c2a'
const MARK = 'B1SECTEST' // marks all test rows

async function findUserByEmail(email) {
  // admin user list is paginated; scan a few pages for the test email
  for (let page = 1; page <= 5; page++) {
    const r = await adminAuth('GET', `admin/users?page=${page}&per_page=200`)
    const users = (r.data && r.data.users) || []
    const u = users.find((x) => x.email === email)
    if (u) return u
    if (users.length < 200) break
  }
  return null
}

async function deleteTestUser(email) {
  const u = await findUserByEmail(email)
  if (u) await adminAuth('DELETE', `admin/users/${u.id}`)
  return u ? u.id : null
}

async function deleteTestRowsFor(userId) {
  // delete only mutable rows we created; never touch append-only ground truth
  for (const table of ['companion_state', 'canonical_people', 'canonical_commitments', 'canonical_facts', 'invites', 'miner_runs']) {
    await svc('DELETE', `${table}?user_id=eq.${userId}`)
  }
}

async function main() {
  console.log('project host:', HOST)

  // --- clean any prior run ---
  await deleteTestUser(EMAIL_A)
  await deleteTestUser(EMAIL_B)

  // --- create two test users ---
  const ca = await adminAuth('POST', 'admin/users', { email: EMAIL_A, password: PASS_A, email_confirm: true })
  const cb = await adminAuth('POST', 'admin/users', { email: EMAIL_B, password: PASS_B, email_confirm: true })
  const A = ca.data && ca.data.id
  const B = cb.data && cb.data.id
  check('created user A', !!A, JSON.stringify(ca.data).slice(0, 200))
  check('created user B', !!B, JSON.stringify(cb.data).slice(0, 200))
  if (!A || !B) { console.log('cannot proceed without both users'); return }
  console.log('  A =', A, '\n  B =', B)

  // --- populate distinct, identifiable DELETABLE data for each (service-role) ---
  const mk = (uid, who) => [
    { table: 'canonical_people', row: { user_id: uid, label: `${MARK}-person-${who}`, data: { aliases: [], note: `${MARK}-${who}` }, source_claim_ids: [], temporality: 'evergreen', confidence: 1, salience: 0.5, summary: `${MARK} ${who} secret person` } },
    { table: 'canonical_commitments', row: { user_id: uid, label: `${MARK}-commitment-${who}`, data: { status: 'open' }, source_claim_ids: [], temporality: 'dated', confidence: 1, salience: 0.5, summary: `${MARK} ${who} owes something` } },
    { table: 'canonical_facts', row: { user_id: uid, label: `${MARK}-fact-${who}`, data: { category: 'secret' }, source_claim_ids: [], temporality: 'decaying', confidence: 0.4, salience: 0.6, summary: `${MARK} ${who} private fact`, last_confirmed_at: '2026-01-01T00:00:00Z' } },
    // B2 tables: an invite the user owns, and a completed miner run for the user.
    { table: 'invites', row: { user_id: uid, email: `${MARK}-invite-${who}@securitytest.local`, status: 'pending' } },
    { table: 'miner_runs', row: { user_id: uid, status: 'done', trigger: 'cli', runtime: 'local', summary: { mark: `${MARK}-${who}` } } },
  ]
  for (const { table, row } of [...mk(A, 'A'), ...mk(B, 'B')]) {
    const r = await svc('POST', table, [row], 'return=representation')
    if (r.status >= 300) check(`seed ${table}`, false, JSON.stringify(r.data).slice(0, 200))
  }

  // --- sign in both users ---
  const signin = async (email, password) => {
    const r = await req('POST', '/auth/v1/token?grant_type=password', { apikey: ANON, body: { email, password } })
    return r.data && r.data.access_token
  }
  const jwtA = await signin(EMAIL_A, PASS_A)
  const jwtB = await signin(EMAIL_B, PASS_B)
  check('user A signed in', !!jwtA)
  check('user B signed in', !!jwtB)
  if (!jwtA || !jwtB) { await teardown(A, B); return }

  // helper: rows returned to a user for a table
  const rowsFor = async (jwt, table, query = 'select=*') => {
    const r = await asUser(jwt, 'GET', `${table}?${query}`)
    return Array.isArray(r.data) ? r.data : []
  }
  const hasMark = (rows, who) => rows.some((x) => JSON.stringify(x).includes(`${MARK}-`) && JSON.stringify(x).includes(`-${who}`))

  console.log('\n== each user sees ONLY their own canonical rows ==')
  for (const [label, jwt, self, other] of [['A', jwtA, 'A', 'B'], ['B', jwtB, 'B', 'A']]) {
    for (const table of ['canonical_people', 'canonical_commitments', 'canonical_facts']) {
      const rows = await rowsFor(jwt, table)
      check(`${label} sees own ${table}`, hasMark(rows, self))
      check(`${label} CANNOT see ${other}'s ${table}`, !hasMark(rows, other), `leaked ${rows.length} rows`)
    }
  }

  console.log('\n== direct lookup of the other user\'s row by id returns nothing ==')
  const bPeople = await rowsFor(jwtB, 'canonical_people', 'select=id')
  const bId = bPeople[0] && bPeople[0].id
  if (bId) {
    const r = await asUser(jwtA, 'GET', `canonical_people?id=eq.${bId}&select=*`)
    check('A fetching B\'s person id directly returns 0 rows', Array.isArray(r.data) && r.data.length === 0, `got ${JSON.stringify(r.data).slice(0,120)}`)
  } else check('found B person id to probe', false)

  console.log('\n== cross-user WRITE is denied ==')
  // A tries to insert a capture stamped as B (INSERT check policy is user_id = auth.uid())
  const wr = await asUser(jwtA, 'POST', 'captures', [{ user_id: B, mode: 'text', body: `${MARK} forged by A as B` }], 'return=representation')
  const inserted = Array.isArray(wr.data) ? wr.data.length : 0
  check('A cannot INSERT a capture stamped as B (RLS check)', wr.status >= 400 || inserted === 0, `status ${wr.status} inserted ${inserted}`)
  // A tries to insert a capture as itself but it must be stamped A only (sanity: allowed for self) -- we do NOT insert (append-only residue); just assert the forged one failed.

  // A tries to UPDATE B's companion overlay (seed one for B first via service role)
  await svc('POST', 'companion_state', [{ user_id: B, commitment_id: '00000000-0000-0000-0000-0000000000bb', state: 'open' }], 'return=representation')
  const up = await asUser(jwtA, 'PATCH', `companion_state?user_id=eq.${B}`, { state: 'dismissed' }, 'return=representation')
  const updated = Array.isArray(up.data) ? up.data.length : 0
  check('A cannot UPDATE B\'s companion_state (0 rows affected)', updated === 0, `updated ${updated}`)

  console.log('\n== B2 tables: invites + miner_runs are per-user ==')
  for (const [label, jwt, self, other] of [['A', jwtA, 'A', 'B'], ['B', jwtB, 'B', 'A']]) {
    for (const table of ['invites', 'miner_runs']) {
      const rows = await rowsFor(jwt, table)
      check(`${label} sees own ${table}`, hasMark(rows, self))
      check(`${label} CANNOT see ${other}'s ${table}`, !hasMark(rows, other), `leaked ${rows.length} rows`)
    }
  }
  // miner_runs has no client write policy (service-role only writes it).
  const mw = await asUser(jwtA, 'POST', 'miner_runs', [{ user_id: A, status: 'running', trigger: 'manual' }], 'return=representation')
  const mwn = Array.isArray(mw.data) ? mw.data.length : 0
  check('A cannot INSERT into miner_runs (service-role only)', mw.status >= 400 || mwn === 0, `status ${mw.status} inserted ${mwn}`)
  // invites INSERT check forbids stamping the row as another user.
  const iw = await asUser(jwtA, 'POST', 'invites', [{ user_id: B, email: `${MARK}-forged@securitytest.local` }], 'return=representation')
  const iwn = Array.isArray(iw.data) ? iw.data.length : 0
  check('A cannot INSERT an invite stamped as B', iw.status >= 400 || iwn === 0, `status ${iw.status} inserted ${iwn}`)

  console.log('\n== the reconfirm view is per-user (security_invoker) ==')
  const vA = await rowsFor(jwtA, 'reconfirm_candidates', 'select=*')
  check('A reconfirm view shows own decaying fact', hasMark(vA, 'A'))
  check('A reconfirm view does NOT show B\'s', !hasMark(vA, 'B'), `leaked ${vA.length}`)

  console.log('\n== anonymous (no JWT) sees zero rows everywhere ==')
  for (const table of ['captures', 'canonical_people', 'canonical_facts', 'companion_state', 'reconfirm_candidates', 'telemetry_events', 'invites', 'miner_runs']) {
    const r = await asAnon('GET', `${table}?select=*`)
    const n = Array.isArray(r.data) ? r.data.length : -1
    check(`anon sees 0 rows in ${table}`, n === 0, `status ${r.status} got ${n} (${JSON.stringify(r.data).slice(0,80)})`)
  }

  console.log('\n== a signed-in user cannot read the pre-existing real user\'s captures ==')
  const aCaps = await rowsFor(jwtA, 'captures', 'select=id')
  check('A sees zero captures (none of its own, none of anyone else\'s)', aCaps.length === 0, `got ${aCaps.length}`)

  await teardown(A, B)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

async function teardown(A, B) {
  console.log('\n== teardown (delete test data + users; no append-only residue) ==')
  if (A) await deleteTestRowsFor(A)
  if (B) await deleteTestRowsFor(B)
  const dA = await deleteTestUser(EMAIL_A)
  const dB = await deleteTestUser(EMAIL_B)
  check('deleted test user A', dA !== null || A === null)
  check('deleted test user B', dB !== null || B === null)
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
