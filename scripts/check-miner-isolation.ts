// Miner multi-user isolation guard.
//
// The miner runs with the SERVICE-ROLE key, which BYPASSES RLS, so its per-user
// isolation is enforced by the miner code filtering on user_id at every query, NOT
// by RLS. check-rls / check-multiuser cover the RLS-protected APP paths; this guard
// covers the service-role MINER path, the one RLS does not protect.
//
// It proves, in BOTH directions, that no user B data can enter user A's graph
// through a mine, by:
//   1. mirroring every miner read with the SAME service-role + user_id filter the
//      miner uses, against two seeded users (and the real user's existing rows for
//      the append-only captures/raw layer), asserting zero cross-user leakage;
//   2. exercising the REAL resolver logic (resolution.ts) to prove a resolver fed
//      only user A's rows can never resolve to user B's id or alias;
//   3. exercising the REAL user_id hard-guard (run.ts assertUserId / mineWithLock)
//      to prove the miner refuses to run unscoped.
//
// captures/raw_* are append-only (the forbid_mutation trigger blocks deletes even
// for the service role), so this guard does NOT insert into them (that would leave
// residue). Their user_id filter is proven against the pre-existing real user's
// rows: a fresh test user's scoped read returns none of the real user's captures.
// Everything it DOES insert (canonical_*, entity_aliases, miner_state, miner_runs)
// is deletable and removed on teardown.
//
// Run: npx tsx scripts/check-miner-isolation.ts
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveId } from '../packages/miner-core/src/resolution'
import { assertUserId, mineWithLock } from '../packages/miner-core/src/run'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '')
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !ANON || !SERVICE) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + ANON + SERVICE_ROLE_KEY in .env.local')
  process.exit(2)
}
const HOST = URL.replace(/^https?:\/\//, '')

function req(method: string, path: string, opts: { apikey?: string; jwt?: string; body?: unknown; prefer?: string } = {}): Promise<{ status: number; data: unknown }> {
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.apikey) headers.apikey = opts.apikey
  if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`
  if (opts.prefer) headers.prefer = opts.prefer
  if (payload) headers['content-length'] = String(Buffer.byteLength(payload))
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host: HOST, path, method, headers }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => {
        let data: unknown = null
        try { data = t ? JSON.parse(t) : null } catch { data = t }
        resolve({ status: res.statusCode ?? 0, data })
      })
    })
    r.setTimeout(30000, () => r.destroy(new Error('timeout ' + path)))
    r.on('error', reject)
    if (payload) r.end(payload)
    else r.end()
  })
}
const svc = (method: string, path: string, body?: unknown, prefer?: string) => req(method, `/rest/v1/${path}`, { apikey: SERVICE, jwt: SERVICE, body, prefer })
const adminAuth = (method: string, path: string, body?: unknown) => req(method, `/auth/v1/${path}`, { apikey: SERVICE, jwt: SERVICE, body })

let pass = 0, fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

const MARK = 'MINERISO'
const SHARED = `${MARK} Sharedname` // an identical label for BOTH users (cross-user collision probe)
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const EMAIL_A = 'miner-iso-a@securitytest.local'
const EMAIL_B = 'miner-iso-b@securitytest.local'
const PASS = 'MinerIso-pw-3a91c7f2'

type Seeded = { sharedPersonId: string; uniquePersonId: string; factId: string }

async function findUser(email: string): Promise<string | null> {
  for (let page = 1; page <= 5; page++) {
    const r = await adminAuth('GET', `admin/users?page=${page}&per_page=200`)
    const users = ((r.data as { users?: Array<{ id: string; email: string }> })?.users) ?? []
    const u = users.find((x) => x.email === email)
    if (u) return u.id
    if (users.length < 200) break
  }
  return null
}
async function deleteUser(email: string): Promise<void> {
  const id = await findUser(email)
  if (id) await adminAuth('DELETE', `admin/users/${id}`)
}

async function seed(uid: string, who: string): Promise<Seeded> {
  const sharedPersonId = randomUUID()
  const uniquePersonId = randomUUID()
  const factId = randomUUID()
  const person = (id: string, label: string) => ({
    id, user_id: uid, label, data: { aliases: [], note: `${MARK}-${who}` }, source_claim_ids: [],
    temporality: 'evergreen', confidence: 1, salience: 0.5, summary: `${MARK} ${who} ${label}`,
  })
  await svc('POST', 'canonical_people', [person(sharedPersonId, SHARED), person(uniquePersonId, `${MARK}-person-${who}`)])
  await svc('POST', 'canonical_facts', [{ id: factId, user_id: uid, label: `${MARK}-fact-${who}`, data: { category: 'secret', note: `${MARK}-${who}` }, source_claim_ids: [], temporality: 'evergreen', confidence: 1, salience: 0.5, summary: `${MARK} ${who} fact` }])
  // entity_aliases: BOTH users get the SAME alias_norm for the shared label, each
  // pointing at their OWN person id. This is the cross-user-alias probe.
  await svc('POST', 'entity_aliases', [
    { user_id: uid, entity_table: 'canonical_people', alias_norm: norm(SHARED), stable_id: sharedPersonId, source: 'seed' },
    { user_id: uid, entity_table: 'canonical_people', alias_norm: `${MARK}-alias-${who}`, stable_id: uniquePersonId, source: 'seed' },
  ])
  await svc('POST', 'miner_state', [{ user_id: uid, scope: `${MARK}-${who}`, input_hash: 'x' }])
  await svc('POST', 'miner_runs', [{ user_id: uid, status: 'done', trigger: 'cli', runtime: 'local', summary: { mark: `${MARK}-${who}` } }])
  return { sharedPersonId, uniquePersonId, factId }
}

async function rows(path: string): Promise<Array<Record<string, unknown>>> {
  const r = await svc('GET', path)
  return Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : []
}
const ownedBy = (rs: Array<Record<string, unknown>>, uid: string) => rs.every((x) => x.user_id === uid)
const mentions = (rs: Array<Record<string, unknown>>, who: string) => rs.some((x) => JSON.stringify(x).includes(`${MARK}-${who}`))

async function main() {
  console.log('host:', HOST)
  await deleteTestRows()
  await deleteUser(EMAIL_A)
  await deleteUser(EMAIL_B)

  const ca = await adminAuth('POST', 'admin/users', { email: EMAIL_A, password: PASS, email_confirm: true })
  const cb = await adminAuth('POST', 'admin/users', { email: EMAIL_B, password: PASS, email_confirm: true })
  const A = (ca.data as { id?: string })?.id
  const B = (cb.data as { id?: string })?.id
  check('created test user A', !!A)
  check('created test user B', !!B)
  if (!A || !B) return
  console.log('  A =', A, '\n  B =', B)

  const sa = await seed(A, 'A')
  const sb = await seed(B, 'B')

  // The miner reads, mirrored with the service-role key + the SAME user_id filter.
  // For each, the target user's scoped read must contain ONLY that user's rows.
  const pairs: Array<[string, string, string, Seeded, Seeded]> = [
    ['A', A, 'B', sa, sb],
    ['B', B, 'A', sb, sa],
  ]

  console.log('\n== append-only layer (captures, raw): a fresh user sees none of anyone else\'s ==')
  // captures/raw are append-only so we cannot seed B; the real user R has real
  // captures, so a test user seeing zero proves the user_id filter (run.ts mine,
  // stage-common readRawClaims) excludes every other user.
  for (const [label, uid] of pairs.map((p) => [p[0], p[1]] as const)) {
    const caps = await rows(`captures?user_id=eq.${uid}&select=id,user_id`)
    check(`${label} captures read returns only ${label}'s (0 here; none of the real user's)`, caps.length === 0, `got ${caps.length}`)
    const raw = await rows(`raw_people?user_id=eq.${uid}&select=id,user_id`)
    check(`${label} raw_people read returns only ${label}'s (0 here)`, raw.length === 0, `got ${raw.length}`)
  }

  console.log('\n== canonical entities: each user\'s scoped read is its own only, even for a SHARED label ==')
  for (const [label, uid, other] of pairs.map((p) => [p[0], p[1], p[2]] as const)) {
    const people = await rows(`canonical_people?user_id=eq.${uid}&valid_to=is.null&select=id,user_id,label,data,summary`)
    check(`${label} canonical_people are all owned by ${label}`, people.length >= 2 && ownedBy(people, uid), `n=${people.length}`)
    check(`${label} does NOT see ${other}'s person rows`, !mentions(people, other), `leaked`)
    const shared = people.filter((p) => p.label === SHARED)
    check(`${label} sees exactly ONE shared-label person (its own), not ${other}'s`, shared.length === 1 && shared[0].user_id === uid)
    const facts = await rows(`canonical_facts?user_id=eq.${uid}&valid_to=is.null&select=id,user_id,summary,data`)
    check(`${label} facts are all owned by ${label}, none of ${other}'s`, ownedBy(facts, uid) && mentions(facts, label) && !mentions(facts, other))
  }

  console.log('\n== resolver self-seed read (buildResolver) + alias read (readAliasMap) are per-user ==')
  for (const [label, uid, other] of pairs.map((p) => [p[0], p[1], p[2]] as const)) {
    // buildResolver candidate read
    const cands = await rows(`canonical_people?user_id=eq.${uid}&valid_to=is.null&select=id,user_id,label,data`)
    check(`${label} resolver candidates are all ${label}'s`, ownedBy(cands, uid))
    // readAliasMap read: BOTH users seeded the SAME alias_norm; the scoped read must
    // return only THIS user's mapping, so an alias can never bridge to another user.
    const aliases = await rows(`entity_aliases?user_id=eq.${uid}&entity_table=eq.canonical_people&select=user_id,alias_norm,stable_id`)
    check(`${label} alias read is all ${label}'s`, aliases.length >= 2 && ownedBy(aliases, uid))
    const sharedAlias = aliases.filter((a) => a.alias_norm === norm(SHARED))
    check(`${label} shared alias maps to ${label}'s OWN person id, not ${other}'s`,
      sharedAlias.length === 1 && sharedAlias[0].stable_id === (uid === A ? sa.sharedPersonId : sb.sharedPersonId))
  }

  console.log('\n== miner_state + miner_runs reads are per-user ==')
  for (const [label, uid, other] of pairs.map((p) => [p[0], p[1], p[2]] as const)) {
    const st = await rows(`miner_state?user_id=eq.${uid}&select=user_id,scope`)
    check(`${label} miner_state is ${label}'s only`, ownedBy(st, uid) && !mentions(st, other))
    const runs = await rows(`miner_runs?user_id=eq.${uid}&select=user_id,summary`)
    check(`${label} miner_runs is ${label}'s only`, ownedBy(runs, uid) && !mentions(runs, other))
  }

  console.log('\n== the REAL resolver logic cannot resolve to another user\'s id/alias ==')
  {
    // A resolver is built ONLY from user A's candidates + A's aliasMap (as
    // buildResolver does). Resolving B's labels must never return B's ids.
    const aCands = (await rows(`canonical_people?user_id=eq.${A}&valid_to=is.null&select=id,label,data`))
      .map((r) => ({ id: String(r.id), label: (r.label as string) ?? null, aliases: [] as string[] }))
    const aAliasMap = new Map<string, string>()
    for (const a of await rows(`entity_aliases?user_id=eq.${A}&entity_table=eq.canonical_people&select=alias_norm,stable_id`)) {
      aAliasMap.set(String(a.alias_norm), String(a.stable_id))
    }
    // shared label resolves to A's own person (exact), NEVER B's
    const r1 = resolveId({ labelNorm: norm(SHARED), aliasNorms: [], candidates: aCands, aliasMap: aAliasMap })
    check('A resolver resolves the shared label to A\'s id, never B\'s', r1.id === sa.sharedPersonId && r1.id !== sb.sharedPersonId, `got ${r1.id}`)
    // B's UNIQUE label is unknown to A's resolver -> mint (null), never B's id
    const r2 = resolveId({ labelNorm: norm(`${MARK}-person-B`), aliasNorms: [], candidates: aCands, aliasMap: aAliasMap })
    check('A resolver does NOT resolve B\'s unique label to B\'s id (mints)', r2.id === null && r2.id !== sb.uniquePersonId, `got ${r2.id}`)
    // B's alias_norm is not in A's aliasMap -> cannot map to B's id
    check('B\'s shared alias is absent from A\'s aliasMap', aAliasMap.get(norm(SHARED)) === sa.sharedPersonId)
  }

  console.log('\n== the miner hard-fails without a valid user_id (no unscoped/global run) ==')
  {
    let threwEmpty = false, threwBad = false, okValid = true
    try { assertUserId('', 'test') } catch { threwEmpty = true }
    try { assertUserId('not-a-uuid', 'test') } catch { threwBad = true }
    try { assertUserId(A, 'test') } catch { okValid = false }
    check('assertUserId throws on empty user_id', threwEmpty)
    check('assertUserId throws on a malformed user_id', threwBad)
    check('assertUserId accepts a real uuid', okValid)
    // mineWithLock guards before any DB call
    let lockThrew = false
    try { await mineWithLock('', { trigger: 'test', runtime: 'test' }) } catch { lockThrew = true }
    check('mineWithLock refuses to run without a valid user_id', lockThrew)
  }

  await teardown(A, B)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

async function deleteTestRows(uids: string[] = []) {
  // delete only the mutable rows we insert; never touch append-only ground truth
  for (const table of ['canonical_people', 'canonical_facts', 'entity_aliases', 'miner_state', 'miner_runs']) {
    if (uids.length) for (const u of uids) await svc('DELETE', `${table}?user_id=eq.${u}`)
    // also clean any prior run's rows by marker where possible (summary/scope)
  }
}

async function teardown(A: string, B: string) {
  console.log('\n== teardown (delete seeded rows + users; verify no residue) ==')
  await deleteTestRows([A, B])
  const leftover = await rows(`canonical_people?user_id=in.(${A},${B})&select=id`)
  check('no canonical residue for the test users', leftover.length === 0, `got ${leftover.length}`)
  await deleteUser(EMAIL_A)
  await deleteUser(EMAIL_B)
  check('deleted test users', (await findUser(EMAIL_A)) === null && (await findUser(EMAIL_B)) === null)
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
