// B1: live two-user isolation test (the security gate).
//
// Proves that two real users cannot read, write, or infer each other's rows
// through ANY path: direct table queries, the canonical layer behind search/chat
// and the contact sheet, the companion overlay, and the reconfirm view. It uses
// two PERMANENT marked guard accounts, populates each with distinct deletable
// data, asserts zero cross-user access as each user (and as an anonymous client),
// then removes the data it created.
//
// RESIDUE, STATED HONESTLY. An earlier version of this comment claimed the guard
// "Leaves NO residue". That was FALSE and it cost 578 unreachable rows. Inserting a
// canonical_* row fires the snapshot_canonical trigger, which writes a
// canonical_history row carrying that user's id. canonical_history is hard
// append-only (forbid_mutation), so teardown cannot remove those rows, and this
// guard never could. What it CAN control is whether they stay reachable: the guard
// used to mint throwaway users and delete them at teardown, which orphaned every
// history row it had generated (no RLS policy can reach them, the predicate is
// user_id = auth.uid() and a deleted user cannot sign in). So:
//   - it inserts only into mutable tables (canonical_*, companion_state, invites,
//     miner_runs, entity_aliases), never the append-only ground truth
//     (captures/raw/corrections), and it deletes every row it inserts;
//   - it leaves canonical_history rows behind, unavoidably, and that is fine
//     because the guard accounts are PERMANENT, so those rows always resolve to a
//     live user and never become orphans.
// NEVER change this guard to delete its auth users. See the standing rule in
// CLAUDE.md.
//
// Requires the permanent accounts to exist: npm run seed:guards (idempotent).
//
// Zero dependencies: uses node:https directly (global fetch and @supabase/supabase-js
// both misbehave in some local environments). Re-runnable: it clears any prior run's
// test ROWS first (never the accounts).
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

// Permanent guard accounts, single source of truth in scripts/guard-accounts.json.
const ACCOUNTS = JSON.parse(readFileSync(join(ROOT, 'scripts', 'guard-accounts.json'), 'utf8'))
const EMAIL_A = ACCOUNTS.a.email
const EMAIL_B = ACCOUNTS.b.email
const PASS_A = ACCOUNTS.a.password
const PASS_B = ACCOUNTS.b.password
const MARK = 'B1SECTEST' // marks all test rows

async function findUserByEmail(email) {
  // admin user list is paginated; scan a few pages for the test email
  for (let page = 1; page <= 10; page++) {
    const r = await adminAuth('GET', `admin/users?page=${page}&per_page=200`)
    const users = (r.data && r.data.users) || []
    const u = users.find((x) => x.email === email)
    if (u) return u
    if (users.length < 200) break
  }
  return null
}

// Resolve a PERMANENT guard account. Never creates, never deletes: creation is the
// seed script's job precisely so no code path here can strand history rows.
async function resolveGuardUser(email) {
  const u = await findUserByEmail(email)
  return u ? u.id : null
}

// Every mutable table this guard seeds. Used for cleanup AND for the start-of-run
// and end-of-run "owns nothing" assertions.
const SEEDED_TABLES = ['companion_state', 'canonical_people', 'canonical_commitments', 'canonical_facts', 'invites', 'miner_runs', 'entity_aliases']

async function deleteTestRowsFor(userId) {
  // delete only mutable rows we created; never touch append-only ground truth.
  // canonical_history rows generated by the snapshot trigger are append-only and
  // stay: that is safe because the guard accounts are permanent, so they are never
  // orphaned. See the header.
  for (const table of SEEDED_TABLES) {
    await svc('DELETE', `${table}?user_id=eq.${userId}`)
  }
}

async function main() {
  console.log('project host:', HOST)

  // --- resolve the two PERMANENT guard accounts (never created, never deleted here) ---
  const A = await resolveGuardUser(EMAIL_A)
  const B = await resolveGuardUser(EMAIL_B)
  check('permanent guard user A resolved', !!A, `${EMAIL_A} missing: run npm run seed:guards`)
  check('permanent guard user B resolved', !!B, `${EMAIL_B} missing: run npm run seed:guards`)
  if (!A || !B) { console.log('cannot proceed without both guard accounts. Run: npm run seed:guards'); return }
  console.log('  A =', A, '\n  B =', B)

  // --- clear any prior run's ROWS, then assert the accounts really start clean ---
  // With permanent accounts, "these users own nothing yet" is no longer true by
  // construction, so it is asserted explicitly. A failure here means a previous run
  // (or another guard) left residue, which would silently weaken every isolation
  // assertion below. Loud beats silent.
  await deleteTestRowsFor(A)
  await deleteTestRowsFor(B)
  for (const [label, uid] of [['A', A], ['B', B]]) {
    let residue = 0
    for (const table of SEEDED_TABLES) {
      const r = await svc('GET', `${table}?user_id=eq.${uid}&select=user_id`)
      residue += Array.isArray(r.data) ? r.data.length : 0
    }
    check(`guard account ${label} starts clean (owns 0 seeded rows)`, residue === 0, `found ${residue}`)
  }

  // --- populate distinct, identifiable DELETABLE data for each (service-role) ---
  const mk = (uid, who) => [
    { table: 'canonical_people', row: { user_id: uid, label: `${MARK}-person-${who}`, data: { aliases: [], note: `${MARK}-${who}` }, source_claim_ids: [], temporality: 'evergreen', confidence: 1, salience: 0.5, summary: `${MARK} ${who} secret person` } },
    { table: 'canonical_commitments', row: { user_id: uid, label: `${MARK}-commitment-${who}`, data: { status: 'open' }, source_claim_ids: [], temporality: 'dated', confidence: 1, salience: 0.5, summary: `${MARK} ${who} owes something` } },
    { table: 'canonical_facts', row: { user_id: uid, label: `${MARK}-fact-${who}`, data: { category: 'secret' }, source_claim_ids: [], temporality: 'decaying', confidence: 0.4, salience: 0.6, summary: `${MARK} ${who} private fact`, last_confirmed_at: '2026-01-01T00:00:00Z' } },
    // B2 tables: an invite the user owns, and a completed miner run for the user.
    { table: 'invites', row: { user_id: uid, email: `${MARK}-invite-${who}@securitytest.local`, status: 'pending' } },
    { table: 'miner_runs', row: { user_id: uid, status: 'done', trigger: 'cli', runtime: 'local', summary: { mark: `${MARK}-${who}` } } },
    // id-hardening: an identity alias row for the user (service-role written).
    { table: 'entity_aliases', row: { user_id: uid, entity_table: 'canonical_people', alias_norm: `${MARK}-alias-${who}`, stable_id: '00000000-0000-0000-0000-0000000000ee' } },
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

  console.log('\n== B2 + identity tables: invites + miner_runs + entity_aliases are per-user ==')
  for (const [label, jwt, self, other] of [['A', jwtA, 'A', 'B'], ['B', jwtB, 'B', 'A']]) {
    for (const table of ['invites', 'miner_runs', 'entity_aliases']) {
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
  for (const table of ['captures', 'canonical_people', 'canonical_facts', 'companion_state', 'reconfirm_candidates', 'telemetry_events', 'invites', 'miner_runs', 'entity_aliases']) {
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
  // The accounts are PERMANENT and are deliberately not deleted. Deleting them is
  // what stranded 578 canonical_history rows. See the standing rule in CLAUDE.md.
  console.log('\n== teardown (delete seeded rows; keep the permanent guard accounts) ==')
  if (A) await deleteTestRowsFor(A)
  if (B) await deleteTestRowsFor(B)
  // Replaces the old "deleted test user A/B" assertions with a strictly stronger
  // one: prove the rows are actually gone rather than proving the account vanished.
  for (const [label, uid] of [['A', A], ['B', B]]) {
    if (!uid) { check(`teardown removed all guard ${label} test rows`, true, 'user was never resolved'); continue }
    let residue = 0
    for (const table of SEEDED_TABLES) {
      const r = await svc('GET', `${table}?user_id=eq.${uid}&select=user_id`)
      residue += Array.isArray(r.data) ? r.data.length : 0
    }
    check(`teardown removed all guard ${label} test rows`, residue === 0, `left ${residue}`)
  }
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
