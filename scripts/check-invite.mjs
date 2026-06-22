// Live auth-gating guard for the email + password + allowlist model. Proves the
// account path works the way the app uses it WITHOUT re-opening public signups:
//   1. public platform signups stay DISABLED (disable_signup = true), the B1
//      posture (only asserted when the management token is available);
//   2. NO BYPASS: an anon-key signUp is rejected and creates no account, so the
//      only way to mint an account is the service-role admin path;
//   3. the app's mint path (admin createUser with a password, email_confirm) works
//      while signups are disabled, sends no email, pre-confirms the address, and
//      stamps app_metadata invited/onboarded (so the onboarding gate fires);
//   4. email + password sign-in works and a wrong password is rejected (no email);
//   5. the allowlist contract over the invites table (mirrors lib/invites isInvited):
//      a pending invite admits the email, a revoked one does not.
// Creates one clearly-marked test user + invite and deletes both on teardown.
//
// Zero deps (node:https), matching the other guards. Run: node scripts/check-invite.mjs
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
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const REF = process.env.SUPABASE_PROJECT_REF
const MGMT = process.env.SUPABASE_ACCESS_TOKEN
if (!URL || !SERVICE || !ANON) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(2)
}
const HOST = URL.replace(/^https?:\/\//, '')

function call(host, path, { method = 'GET', apikey, bearer, body, prefer } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers = { 'content-type': 'application/json' }
  if (apikey) headers.apikey = apikey
  if (bearer) headers.authorization = `Bearer ${bearer}`
  if (prefer) headers.prefer = prefer
  if (payload) headers['content-length'] = Buffer.byteLength(payload)
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host, path, method, headers }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => { let d = null; try { d = t ? JSON.parse(t) : null } catch { d = t } resolve({ status: res.statusCode, data: d }) })
    })
    r.setTimeout(30000, () => r.destroy(new Error('timeout ' + path)))
    r.on('error', reject)
    if (payload) r.end(payload); else r.end()
  })
}
const authAdmin = (method, path, body) => call(HOST, `/auth/v1/${path}`, { method, apikey: SERVICE, bearer: SERVICE, body })
const authAnon = (method, path, body) => call(HOST, `/auth/v1/${path}`, { method, apikey: ANON, body })
const rest = (method, path, body, prefer) => call(HOST, `/rest/v1/${path}`, { method, apikey: SERVICE, bearer: SERVICE, body, prefer })

let pass = 0, fail = 0
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) } }

const EMAIL = 'authtest-emailpw@securitytest.local'
const ENC = encodeURIComponent(EMAIL)
const PASSWORD = 'Test-passw0rd!' // meets the policy (>=8, letter, number, special)

async function findUser(email) {
  for (let page = 1; page <= 5; page++) {
    const r = await authAdmin('GET', `admin/users?page=${page}&per_page=200`)
    const users = (r.data && r.data.users) || []
    const u = users.find((x) => x.email === email)
    if (u) return u
    if (users.length < 200) break
  }
  return null
}

async function cleanup() {
  const u = await findUser(EMAIL)
  if (u) await authAdmin('DELETE', `admin/users/${u.id}`)
  await rest('DELETE', `invites?email=eq.${ENC}`)
}

async function main() {
  console.log('project host:', HOST)
  await cleanup()

  // 1) public signups must stay DISABLED (B1 posture; no regression).
  if (REF && MGMT) {
    const cfg = await call('api.supabase.com', `/v1/projects/${REF}/config/auth`, { bearer: MGMT })
    check('public signups remain DISABLED (disable_signup = true)', cfg.data && cfg.data.disable_signup === true, JSON.stringify(cfg.data && cfg.data.disable_signup))
  } else {
    console.log('  skip disable_signup check (no SUPABASE_ACCESS_TOKEN / PROJECT_REF)')
  }

  // 2) NO BYPASS: an anon-key signUp is rejected and mints no account.
  const su = await authAnon('POST', 'signup', { email: EMAIL, password: PASSWORD })
  check('anon-key public signUp is rejected (>=400)', su.status >= 400, `status ${su.status} ${JSON.stringify(su.data).slice(0, 160)}`)
  check('anon-key signUp returns no session (no bypass)', !(su.data && (su.data.access_token || (su.data.user && su.data.user.id) || su.data.id)), JSON.stringify(su.data).slice(0, 160))
  check('anon-key signUp created no account', !(await findUser(EMAIL)))

  // 3) the app's mint path: admin createUser with a password works while disabled.
  const cu = await authAdmin('POST', 'admin/users', {
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { invited: true, onboarded: false },
  })
  const userId = cu.data && (cu.data.id || (cu.data.user && cu.data.user.id))
  check('admin createUser mints an account while signups are disabled', !!userId, `status ${cu.status} ${JSON.stringify(cu.data).slice(0, 200)}`)

  if (userId) {
    const got = await authAdmin('GET', `admin/users/${userId}`)
    const user = (got.data && (got.data.user || got.data)) || {}
    check('minted account is email-confirmed (no verification email needed)', !!(user.email_confirmed_at || user.confirmed_at), JSON.stringify({ ec: user.email_confirmed_at, c: user.confirmed_at }))
    const meta = user.app_metadata || {}
    check('minted account has app_metadata.invited = true', meta.invited === true, JSON.stringify(meta))
    check('minted account has app_metadata.onboarded = false (gate forces onboarding)', meta.onboarded === false, JSON.stringify(meta))

    // 4) email + password sign-in works (no email); wrong password rejected.
    const si = await authAnon('POST', 'token?grant_type=password', { email: EMAIL, password: PASSWORD })
    check('email + password sign-in succeeds (no email on login)', si.status === 200 && si.data && !!si.data.access_token, `status ${si.status}`)
    const bad = await authAnon('POST', 'token?grant_type=password', { email: EMAIL, password: 'Wrong-passw0rd!' })
    check('wrong password is rejected', bad.status >= 400 && !(bad.data && bad.data.access_token), `status ${bad.status}`)

    // 5) allowlist contract over invites (mirrors lib/invites.isInvited).
    const ins = await rest('POST', 'invites', { user_id: userId, email: EMAIL, status: 'pending' }, 'return=representation')
    const inviteId = Array.isArray(ins.data) ? ins.data[0] && ins.data[0].id : ins.data && ins.data.id
    check('invite row created (allowlist entry)', !!inviteId, `status ${ins.status} ${JSON.stringify(ins.data).slice(0, 160)}`)
    const q1 = await rest('GET', `invites?select=id&email=eq.${ENC}&status=neq.revoked`)
    check('allowlist admits a pending invite (isInvited = true)', Array.isArray(q1.data) && q1.data.length === 1, JSON.stringify(q1.data))
    if (inviteId) await rest('PATCH', `invites?id=eq.${inviteId}`, { status: 'revoked' })
    const q2 = await rest('GET', `invites?select=id&email=eq.${ENC}&status=neq.revoked`)
    check('allowlist rejects a revoked invite (isInvited = false)', Array.isArray(q2.data) && q2.data.length === 0, JSON.stringify(q2.data))
  }

  // teardown
  await cleanup()
  check('test user deleted (no residue)', !(await findUser(EMAIL)))
  const left = await rest('GET', `invites?select=id&email=eq.${ENC}`)
  check('test invite deleted (no residue)', Array.isArray(left.data) && left.data.length === 0, JSON.stringify(left.data))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('ERROR', e); process.exit(1) })
