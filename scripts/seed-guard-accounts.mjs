// Seed the PERMANENT security-guard accounts. Idempotent. NEVER deletes.
//
// WHY THIS EXISTS: check-multiuser.mjs and check-miner-isolation.ts used to mint a
// pair of throwaway auth users on every run, seed canonical rows for them, and
// delete the users at teardown. Seeding a canonical row fires the snapshot_canonical
// trigger, which writes a canonical_history row carrying that user's id.
// canonical_history is hard append-only (forbid_mutation), so teardown could never
// remove those rows, and once the auth user was deleted no RLS policy could ever
// reach them again (the predicate is user_id = auth.uid() and no such user can sign
// in). 578 unreachable rows across 97 vanished users accumulated that way, and they
// blocked the Phase 1 scope backfill, which sets scope_id NOT NULL by joining
// user_id to that user's personal scope.
//
// The fix is to stop deleting the users. The guards now reuse these two permanent
// accounts, so the history rows they still generate always resolve to a live user
// and never become orphans.
//
// Run once per environment (safe to re-run):
//   npm run seed:guards
//
// Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
// Zero dependencies: node:https directly, matching the other live guards (global
// fetch and @supabase/supabase-js both misbehave in some local environments).
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
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !SERVICE) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(2)
}
const HOST = URL.replace(/^https?:\/\//, '')
export const ACCOUNTS = JSON.parse(readFileSync(join(ROOT, 'scripts', 'guard-accounts.json'), 'utf8'))

function req(method, path, body) {
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers = { 'content-type': 'application/json', apikey: SERVICE, authorization: `Bearer ${SERVICE}` }
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

async function findUser(email) {
  for (let page = 1; page <= 10; page++) {
    const r = await req('GET', `/auth/v1/admin/users?page=${page}&per_page=200`)
    const users = (r.data && r.data.users) || []
    const u = users.find((x) => x.email === email)
    if (u) return u.id
    if (users.length < 200) break
  }
  return null
}

// Ensure the account exists with the expected password. If it already exists we
// PUT the password rather than recreating, so an environment whose guard account
// drifted is repaired without ever deleting (and thus without stranding history).
async function ensure(label, { email, password }) {
  const existing = await findUser(email)
  if (existing) {
    const upd = await req('PUT', `/auth/v1/admin/users/${existing}`, { password, email_confirm: true })
    if (upd.status >= 300) {
      console.error(`  FAIL ${label} ${email}: could not refresh password (${upd.status})`)
      return null
    }
    console.log(`  ok   ${label} ${email} already exists (${existing}), password refreshed`)
    return existing
  }
  const created = await req('POST', '/auth/v1/admin/users', { email, password, email_confirm: true })
  const id = created.data && created.data.id
  if (!id) {
    console.error(`  FAIL ${label} ${email}: ${JSON.stringify(created.data).slice(0, 300)}`)
    return null
  }
  console.log(`  ok   ${label} ${email} created (${id})`)
  return id
}

async function main() {
  console.log('project host:', HOST)
  console.log('\n== permanent guard accounts (created once, never deleted) ==')
  const a = await ensure('A', ACCOUNTS.a)
  const b = await ensure('B', ACCOUNTS.b)
  if (!a || !b) {
    console.error('\nseed FAILED. The guards cannot run until both accounts exist.')
    process.exit(1)
  }
  console.log('\nboth guard accounts ready. Do NOT delete them: see the standing rule in CLAUDE.md.')
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
