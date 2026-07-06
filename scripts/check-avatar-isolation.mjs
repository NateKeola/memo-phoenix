// Live two-user isolation test for the profile + avatar surface (migration 0020).
//
// check-rls covers public tables only, so the Storage bucket (storage schema) needs
// its own behavioral proof: a user can read/write ONLY their own avatar object and
// their own user_profiles row, and can never touch another user's. Creates two real
// users, exercises both directions against the REST + Storage APIs with each user's
// JWT, and self-cleans (deletes the objects, profile rows, and users). Zero deps
// (node:https), so it runs under the local fetch wedge, like check-multiuser.
//
// Run: node scripts/check-avatar-isolation.mjs
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
if (!URL || !ANON || !SERVICE) { console.error('need SUPABASE URL + ANON + SERVICE_ROLE keys'); process.exit(2) }
const HOST = URL.replace(/^https?:\/\//, '')

function raw(method, path, { jwt, apikey, contentType, body } = {}) {
  const headers = {}
  if (apikey) headers.apikey = apikey
  if (jwt) headers.authorization = `Bearer ${jwt}`
  if (contentType) headers['content-type'] = contentType
  if (body) headers['content-length'] = Buffer.byteLength(body)
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host: HOST, path, method, headers }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => { let d = null; try { d = t ? JSON.parse(t) : null } catch { d = t } resolve({ status: res.statusCode, data: d }) })
    })
    r.setTimeout(30000, () => r.destroy(new Error('timeout ' + path)))
    r.on('error', reject)
    if (body) r.end(body); else r.end()
  })
}
const json = (v) => (v === undefined ? undefined : Buffer.from(JSON.stringify(v)))
const adminAuth = (method, path, body) => raw(method, `/auth/v1/${path}`, { apikey: SERVICE, jwt: SERVICE, contentType: 'application/json', body: json(body) })
const svcRest = (method, path, body) => raw(method, `/rest/v1/${path}`, { apikey: SERVICE, jwt: SERVICE, contentType: 'application/json', body: json(body) })
const asUserRest = (jwt, method, path, body, prefer) =>
  raw(method, `/rest/v1/${path}`, { apikey: ANON, jwt, contentType: 'application/json', body: json(body) }).then((r) => r)
// Storage: upload (raw bytes), download, list (json body), sign.
const stUpload = (jwt, path, buf) => raw('POST', `/storage/v1/object/avatars/${path}`, { apikey: ANON, jwt, contentType: 'image/png', body: buf })
const stUploadUpsert = (jwt, path, buf) => new Promise((res, rej) => {
  const headers = { apikey: ANON, authorization: `Bearer ${jwt}`, 'content-type': 'image/png', 'x-upsert': 'true', 'content-length': buf.length }
  const r = httpsRequest({ host: HOST, path: `/storage/v1/object/avatars/${path}`, method: 'POST', headers }, (x) => { let t=''; x.on('data',c=>t+=c); x.on('end',()=>{let d=null;try{d=t?JSON.parse(t):null}catch{d=t}res({status:x.statusCode,data:d})}) })
  r.on('error', rej); r.end(buf)
})
const stDownload = (jwt, path) => raw('GET', `/storage/v1/object/avatars/${path}`, { apikey: ANON, jwt })
const stList = (jwt, prefix) => raw('POST', `/storage/v1/object/list/avatars`, { apikey: ANON, jwt, contentType: 'application/json', body: json({ prefix, limit: 100 }) })
const stSign = (jwt, path) => raw('POST', `/storage/v1/object/sign/avatars/${path}`, { apikey: ANON, jwt, contentType: 'application/json', body: json({ expiresIn: 60 }) })
const stDeleteSvc = (path) => raw('DELETE', `/storage/v1/object/avatars/${path}`, { apikey: SERVICE, jwt: SERVICE })

let pass = 0, fail = 0
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) } }

const EMAIL_A = 'avatartest-a@securitytest.local'
const EMAIL_B = 'avatartest-b@securitytest.local'
const PASS_A = 'Avatartest-A-9f3a2b1c'
const PASS_B = 'Avatartest-B-7d8e4c2a'
// a 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

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
async function delUser(email) { const u = await findUser(email); if (u) await adminAuth('DELETE', `admin/users/${u.id}`); return u ? u.id : null }
const signin = async (email, password) => (await raw('POST', '/auth/v1/token?grant_type=password', { apikey: ANON, contentType: 'application/json', body: json({ email, password }) })).data?.access_token

async function main() {
  console.log('project host:', HOST)
  await delUser(EMAIL_A); await delUser(EMAIL_B)
  const ca = await adminAuth('POST', 'admin/users', { email: EMAIL_A, password: PASS_A, email_confirm: true })
  const cb = await adminAuth('POST', 'admin/users', { email: EMAIL_B, password: PASS_B, email_confirm: true })
  const A = ca.data?.id, B = cb.data?.id
  check('created user A', !!A); check('created user B', !!B)
  if (!A || !B) return finish()
  const jwtA = await signin(EMAIL_A, PASS_A), jwtB = await signin(EMAIL_B, PASS_B)
  check('both signed in', !!jwtA && !!jwtB)
  if (!jwtA || !jwtB) { await teardown(A, B); return finish() }

  const aPath = `${A}/avatar_test.png`, bPath = `${B}/avatar_test.png`

  // --- user_profiles isolation ---
  const ownIns = await asUserRest(jwtA, 'POST', 'user_profiles', { user_id: A, display_name: 'A test' }, 'return=representation')
  check('A can upsert its OWN user_profiles row', ownIns.status < 300, `status ${ownIns.status}`)
  const forgeIns = await asUserRest(jwtA, 'POST', 'user_profiles', { user_id: B, display_name: 'forged by A' })
  check('A CANNOT insert a user_profiles row for B (RLS)', forgeIns.status >= 400 || (Array.isArray(forgeIns.data) && forgeIns.data.length === 0), `status ${forgeIns.status}`)
  await asUserRest(jwtB, 'POST', 'user_profiles', { user_id: B, display_name: 'B test' }, 'return=representation')
  const aSees = await asUserRest(jwtA, 'GET', 'user_profiles?select=user_id')
  const aRows = Array.isArray(aSees.data) ? aSees.data : []
  check('A sees ONLY its own user_profiles row', aRows.length === 1 && aRows[0].user_id === A, JSON.stringify(aRows).slice(0, 120))

  // --- avatar object isolation ---
  const upOwn = await stUploadUpsert(jwtA, aPath, PNG)
  check('A can upload its OWN avatar object', upOwn.status < 300, `status ${upOwn.status} ${JSON.stringify(upOwn.data).slice(0,120)}`)
  await stUploadUpsert(jwtB, bPath, PNG) // B uploads its own so there is a target to attempt
  const upOther = await stUpload(jwtA, bPath, PNG)
  check('A CANNOT upload into B\'s folder (RLS)', upOther.status >= 400, `status ${upOther.status}`)
  const dlOwn = await stDownload(jwtA, aPath)
  check('A can download its OWN avatar', dlOwn.status < 300, `status ${dlOwn.status}`)
  const dlOther = await stDownload(jwtA, bPath)
  check('A CANNOT download B\'s avatar (RLS)', dlOther.status >= 400, `status ${dlOther.status}`)
  const listOther = await stList(jwtA, `${B}/`)
  const listRows = Array.isArray(listOther.data) ? listOther.data : []
  check('A listing B\'s folder returns NOTHING (RLS)', listRows.length === 0, JSON.stringify(listRows).slice(0, 120))
  const listOwn = await stList(jwtA, `${A}/`)
  check('A can list its OWN folder', Array.isArray(listOwn.data) && listOwn.data.length >= 1, JSON.stringify(listOwn.data).slice(0, 120))
  const signOther = await stSign(jwtA, bPath)
  check('A CANNOT sign a URL for B\'s avatar (RLS)', signOther.status >= 400, `status ${signOther.status}`)
  const anonDl = await raw('GET', `/storage/v1/object/avatars/${aPath}`, { apikey: ANON })
  check('anonymous CANNOT download a private avatar', anonDl.status >= 400, `status ${anonDl.status}`)

  await teardown(A, B, aPath, bPath)
  // residue check
  const leftA = await findUser(EMAIL_A), leftB = await findUser(EMAIL_B)
  check('test users removed (no residue)', !leftA && !leftB)
  finish()
}

async function teardown(A, B, aPath, bPath) {
  if (aPath) await stDeleteSvc(aPath)
  if (bPath) await stDeleteSvc(bPath)
  if (A) await svcRest('DELETE', `user_profiles?user_id=eq.${A}`)
  if (B) await svcRest('DELETE', `user_profiles?user_id=eq.${B}`)
  await delUser(EMAIL_A); await delUser(EMAIL_B)
}

function finish() { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail === 0 ? 0 : 1) }
main().catch((e) => { console.error(e); process.exit(1) })
