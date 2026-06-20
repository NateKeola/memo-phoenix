// B2: live invite-flow guard. Proves the invite-only account path works the way
// the app uses it WITHOUT re-opening public signups:
//   - an account is minted via the admin API (generateLink type=invite), which is
//     exempt from the signup toggle, so it works while disable_signup stays true;
//   - the new account carries app_metadata { invited:true, onboarded:false }, which
//     the middleware onboarding gate reads (so a new user is sent to onboarding);
//   - public signups remain DISABLED (the B1 constraint must not regress).
// Creates one clearly-marked test user and deletes it on teardown (no residue).
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
const REF = process.env.SUPABASE_PROJECT_REF
const MGMT = process.env.SUPABASE_ACCESS_TOKEN
if (!URL || !SERVICE) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY')
  process.exit(2)
}
const HOST = URL.replace(/^https?:\/\//, '')

function req(host, path, { apikey, jwt, body, bearer } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers = { 'content-type': 'application/json' }
  if (apikey) headers.apikey = apikey
  if (jwt) headers.authorization = `Bearer ${jwt}`
  if (bearer) headers.authorization = `Bearer ${bearer}`
  if (payload) headers['content-length'] = Buffer.byteLength(payload)
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host, path, method: body === undefined ? 'GET' : 'POST', headers }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => { let d = null; try { d = t ? JSON.parse(t) : null } catch { d = t } resolve({ status: res.statusCode, data: d }) })
    })
    r.setTimeout(30000, () => r.destroy(new Error('timeout ' + path)))
    r.on('error', reject)
    if (payload) r.end(payload); else r.end()
  })
}
const adminAuth = (method, path, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const headers = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' }
    if (payload) headers['content-length'] = Buffer.byteLength(payload)
    const r = httpsRequest({ host: HOST, path: `/auth/v1/${path}`, method, headers }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { let d = null; try { d = t ? JSON.parse(t) : null } catch { d = t } resolve({ status: res.statusCode, data: d }) })
    })
    r.setTimeout(30000, () => r.destroy(new Error('timeout ' + path)))
    r.on('error', reject); if (payload) r.end(payload); else r.end()
  })

let pass = 0, fail = 0
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) } }

const EMAIL = 'b2-invitetest@securitytest.local'

async function findUser(email) {
  for (let page = 1; page <= 5; page++) {
    const r = await adminAuth('GET', `admin/users?page=${page}&per_page=200`)
    const users = (r.data && r.data.users) || []
    const u = users.find((x) => x.email === email)
    if (u) return u
    if (users.length < 200) break
  }
  return null
}

async function main() {
  console.log('project host:', HOST)
  // clean any prior run
  const prior = await findUser(EMAIL)
  if (prior) await adminAuth('DELETE', `admin/users/${prior.id}`)

  // 1) mint an invited account via the admin link API (the app's path)
  const gl = await adminAuth('POST', 'admin/generate_link', {
    type: 'invite',
    email: EMAIL,
    redirect_to: 'http://localhost:3000/auth/callback?next=/onboarding',
  })
  const actionLink = gl.data && (gl.data.action_link || (gl.data.properties && gl.data.properties.action_link))
  const userId = gl.data && (gl.data.user_id || (gl.data.user && gl.data.user.id) || gl.data.id)
  check('admin generate_link(invite) succeeds while signups are disabled', !!actionLink && !!userId, `status ${gl.status} ${JSON.stringify(gl.data).slice(0, 200)}`)
  check('invite action link points at the app callback', typeof actionLink === 'string' && actionLink.includes('/auth/'), String(actionLink).slice(0, 120))

  if (userId) {
    // 2) stamp app_metadata exactly as the app helper does
    await adminAuth('PUT', `admin/users/${userId}`, { app_metadata: { invited: true, onboarded: false } })
    const got = await adminAuth('GET', `admin/users/${userId}`)
    const meta = (got.data && (got.data.app_metadata || (got.data.user && got.data.user.app_metadata))) || {}
    check('invited account has app_metadata.invited = true', meta.invited === true, JSON.stringify(meta))
    check('invited account has app_metadata.onboarded = false (gate will force onboarding)', meta.onboarded === false, JSON.stringify(meta))
  }

  // 3) public signups must still be DISABLED (B1 constraint, no regression)
  if (REF && MGMT) {
    const cfg = await req('api.supabase.com', `/v1/projects/${REF}/config/auth`, { bearer: MGMT })
    check('public signups remain DISABLED (disable_signup = true)', cfg.data && cfg.data.disable_signup === true, JSON.stringify(cfg.data && cfg.data.disable_signup))
  } else {
    console.log('  skip signup-disabled check (no SUPABASE_ACCESS_TOKEN / PROJECT_REF)')
  }

  // teardown
  const u = await findUser(EMAIL)
  if (u) await adminAuth('DELETE', `admin/users/${u.id}`)
  check('test invite user deleted (no residue)', !(await findUser(EMAIL)))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('ERROR', e); process.exit(1) })
