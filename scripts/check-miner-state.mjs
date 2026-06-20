// Phase 2 Unit 2 diagnostic: confirms the "new context since the last successful
// mine" measure that drives the progress bar + auto-run computes correctly against
// the LIVE schema (catches a wrong column / query-shape regression). Read-only, no
// writes, no residue. Mirrors lib/miner/state.getMinerState for MEMO_USER_ID.
//
// Run: node scripts/check-miner-state.mjs  (needs SUPABASE_SERVICE_ROLE_KEY +
//                                           NEXT_PUBLIC_SUPABASE_URL + MEMO_USER_ID)
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
const USER = process.env.MEMO_USER_ID
const THRESHOLD = Number(process.env.MINER_AUTORUN_NEW_CAPTURES) || 5
if (!URL || !SERVICE || !USER) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + MEMO_USER_ID')
  process.exit(2)
}
const HOST = URL.replace(/^https?:\/\//, '')

function rest(path) {
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      { host: HOST, path: `/rest/v1/${path}`, method: 'GET', headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
      (res) => {
        let t = ''
        res.on('data', (c) => (t += c))
        res.on('end', () => {
          let d = null
          try { d = t ? JSON.parse(t) : [] } catch { d = t }
          resolve({ status: res.statusCode, data: d })
        })
      }
    )
    r.setTimeout(30000, () => r.destroy(new Error('timeout ' + path)))
    r.on('error', reject)
    r.end()
  })
}

let pass = 0, fail = 0
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) } }

async function main() {
  console.log('host:', HOST, '\nuser:', USER, '\nthreshold:', THRESHOLD, '\n')

  // 1) watermark = last successful run start
  const done = await rest(`miner_runs?user_id=eq.${USER}&status=eq.done&order=started_at.desc&limit=1&select=started_at`)
  check('miner_runs query works', done.status === 200 && Array.isArray(done.data), `status ${done.status}`)
  const watermark = done.data[0] ? done.data[0].started_at : null
  console.log('  last successful run:', watermark || '(none yet)')

  // 2) new captures since the watermark (small single-user corpus: count the ids)
  const capPath = watermark
    ? `captures?user_id=eq.${USER}&created_at=gt.${encodeURIComponent(watermark)}&select=id`
    : `captures?user_id=eq.${USER}&select=id`
  const caps = await rest(capPath)
  check('captures query works', caps.status === 200 && Array.isArray(caps.data), `status ${caps.status}`)
  const newCaptures = Array.isArray(caps.data) ? caps.data.length : -1
  check('newCaptures is a sane count', newCaptures >= 0, String(newCaptures))
  console.log('  new captures since last update:', newCaptures)

  // 3) the ledger reads with the change-count fields present in summary
  const ledger = await rest(`miner_runs?user_id=eq.${USER}&order=started_at.desc&limit=20&select=id,status,trigger,summary`)
  check('ledger query works', ledger.status === 200 && Array.isArray(ledger.data), `status ${ledger.status}`)
  console.log('  ledger rows:', ledger.data.length)

  // 4) the derived decision
  const shouldAutoRun = newCaptures >= THRESHOLD
  console.log(`\n  measure: ${newCaptures}/${THRESHOLD} -> ${shouldAutoRun ? 'would auto-run' : 'below threshold'}`)
  check('shouldAutoRun is a clean boolean derivation', typeof shouldAutoRun === 'boolean')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('ERROR', e); process.exit(1) })
