#!/usr/bin/env node
// Conservatively seed the incremental miner's `incorporated:<capture_id>` markers for
// captures ALREADY represented in the current canonical graph, so the next mine is a
// fast INCREMENTAL run over only the genuinely-new captures instead of a full
// recompute.
//
// Why: the incremental pass (packages/miner-core/src/incremental.ts) does a FULL
// recompute when there are 0 `incorporated:` markers (baseline) or the corrections
// fingerprint changed. A user whose baseline was built by a plain `runDerivation`
// (which does NOT write markers) has 0 markers, so every mine is a slow full
// recompute. Seeding markers for the represented captures + the current corrections
// fingerprint moves the user to a working incremental state without a full recompute.
//
// SAFETY (the load-bearing rule): err toward NOT marking. Marking a genuinely-new
// capture would skip it forever (data loss). Leaving an already-represented capture
// unmarked only causes harmless reprocessing on the next run. So a capture is marked
// ONLY if at least one of its raw claims is cited by a CURRENT canonical row
// (source_claim_ids), which is direct proof its content is in the graph. New captures
// have zero cited claims and are left unmarked.
//
// The corrections fingerprint is seeded ONLY when every people correction is already
// reflected in the graph (from-label superseded, to/into-label current). If a wrong
// fingerprint were ever seeded it would be safe anyway (the next run would just
// full-recompute), but we gate it so a pending correction is never skipped.
//
// Usage:
//   node scripts/seed-incorporated.mjs --user <uuid>            dry run (default): print the plan
//   node scripts/seed-incorporated.mjs --user <uuid> --apply    write the markers + fingerprint
//
// Credentials (same as scripts/db.mjs): SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN
// from the env, falling back to .env.local. Zero npm deps (node:https), so it runs
// under the local tsx/undici wedge.

import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const userArg = args.indexOf('--user')
loadEnvLocal()
const USER = userArg !== -1 ? args[userArg + 1] : process.env.MEMO_USER_ID
const REF = need('SUPABASE_PROJECT_REF')
const TOKEN = need('SUPABASE_ACCESS_TOKEN')
if (!USER || !/^[0-9a-f-]{36}$/i.test(USER)) fail('pass --user <uuid> (or set MEMO_USER_ID)')

const RAW = ['raw_people', 'raw_places_orgs', 'raw_projects', 'raw_events', 'raw_facts', 'raw_commitments', 'raw_relationships', 'raw_collection_mentions']
const CANON = ['canonical_people', 'canonical_places_orgs', 'canonical_projects', 'canonical_events', 'canonical_facts', 'canonical_commitments', 'canonical_relationships', 'insights']
const CORR_FP_SCOPE = 'incremental:corrections_fp'

// ---- identity.ts canonicalJson + sha256 (verbatim), for the corrections fingerprint
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v
  const keys = Object.keys(o).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

async function main() {
  console.log(`[seed] user ${USER}  mode=${APPLY ? 'APPLY' : 'DRY RUN'}\n`)

  // 1. represented vs new captures
  const citedUnion = CANON.map((t) => `select unnest(source_claim_ids) cid from public.${t} where user_id='${USER}' and valid_to is null`).join(' union ')
  const rawCaps = RAW.map((t) => `select id, capture_id from public.${t} where user_id='${USER}'`).join(' union all ')
  const rows = await sql(`
    with cited as (select distinct cid from (${citedUnion}) z),
    raw_caps as (${rawCaps}),
    represented as (select distinct rc.capture_id cap from raw_caps rc join cited c on rc.id::text = c.cid::text)
    select c.id, to_char(c.created_at,'YYYY-MM-DD HH24:MI') created, (c.id in (select cap from represented)) represented
    from public.captures c where c.user_id='${USER}' order by c.created_at;`)
  const represented = rows.filter((r) => r.represented === true).map((r) => r.id)
  const unrepresented = rows.filter((r) => r.represented !== true)
  console.log(`captures: ${rows.length} total`)
  console.log(`  represented (will be marked incorporated): ${represented.length}`)
  console.log(`  new / unrepresented (left unmarked -> processed by the next incremental run): ${unrepresented.length}`)
  for (const r of unrepresented) console.log(`    NEW  ${r.created}  ${r.id}`)

  // 2. corrections already applied? (gate for seeding the fingerprint)
  const corr = await sql(`select kind, payload from public.corrections where user_id='${USER}' and kind in ('rename_person','merge_people') order by created_at asc;`)
  const fingerprint = corr.length ? sha256(canonicalJson(corr.map((c) => ({ k: c.kind, p: c.payload })))) : ''
  // A correction is PENDING only if its pre-correction (from) label is still a CURRENT
  // person that has yet to be renamed. from-current=0 means the correction is already
  // applied (the loser row is superseded) OR inert (no current person under that
  // label, e.g. the person is stored under a shorter form) - either way there is
  // nothing to skip, so it is safe to record the fingerprint. to-current is shown for
  // context only (an inert correction has neither label current).
  let noCorrectionPending = true
  for (const c of corr) {
    const from = (c.payload.from_label ?? c.payload.from ?? '').toString()
    const to = (c.kind === 'merge_people' ? c.payload.into_label ?? c.payload.into : c.payload.to_label ?? c.payload.to ?? '').toString()
    if (!from) continue
    const fromCur = await scalar(`select count(*)::int n from public.canonical_people where user_id='${USER}' and valid_to is null and lower(label)=lower('${esc(from)}');`)
    const toCur = to ? await scalar(`select count(*)::int n from public.canonical_people where user_id='${USER}' and valid_to is null and lower(label)=lower('${esc(to)}');`) : 0
    const pending = fromCur >= 1
    if (pending) noCorrectionPending = false
    console.log(`  correction ${c.kind}: "${from}" -> "${to}"  pending=${pending} (from current=${fromCur}, to current=${toCur})`)
  }
  console.log(`corrections: ${corr.length}, fingerprint=${fingerprint || '(none)'}, no correction pending=${noCorrectionPending}`)
  const existingFp = await scalar(`select count(*)::int n from public.miner_state where user_id='${USER}' and scope='${CORR_FP_SCOPE}';`)
  const existingMarkers = await scalar(`select count(*)::int n from public.miner_state where user_id='${USER}' and scope like 'incorporated:%';`)
  console.log(`existing incorporated markers: ${existingMarkers}; existing corrections_fp rows: ${existingFp}\n`)

  const willSeedFp = corr.length > 0 && noCorrectionPending
  if (corr.length > 0 && !noCorrectionPending) {
    console.log('WARNING: a correction is still pending (its from-label is a current person); NOT seeding the corrections fingerprint.')
    console.log('The next run will full-recompute (which applies it). Re-run this after that mine to enable the fast path.\n')
  }

  if (!APPLY) {
    console.log('DRY RUN: no writes. Re-run with --apply to seed:')
    console.log(`  - ${represented.length} incorporated:<id> markers`)
    console.log(`  - ${willSeedFp ? 1 : 0} corrections_fp marker (${willSeedFp ? fingerprint : 'skipped'})`)
    return
  }

  // 3. APPLY: insert markers (idempotent) + the fingerprint
  const now = new Date().toISOString()
  for (let i = 0; i < represented.length; i += 200) {
    const chunk = represented.slice(i, i + 200)
    const values = chunk.map((id) => `('${USER}','incorporated:${id}','incorporated','${now}')`).join(',')
    await sql(`insert into public.miner_state (user_id, scope, input_hash, updated_at) values ${values} on conflict (user_id, scope) do nothing;`)
  }
  if (willSeedFp) {
    await sql(`insert into public.miner_state (user_id, scope, input_hash, updated_at) values ('${USER}','${CORR_FP_SCOPE}','${fingerprint}','${now}') on conflict (user_id, scope) do update set input_hash=excluded.input_hash, updated_at=excluded.updated_at;`)
  }

  // 4. verify
  const afterMarkers = await scalar(`select count(*)::int n from public.miner_state where user_id='${USER}' and scope like 'incorporated:%';`)
  const afterUnincorporated = await scalar(`select count(*)::int n from public.captures c where c.user_id='${USER}' and not exists (select 1 from public.miner_state m where m.user_id='${USER}' and m.scope='incorporated:'||c.id::text);`)
  const afterFp = await scalar(`select input_hash from public.miner_state where user_id='${USER}' and scope='${CORR_FP_SCOPE}';`)
  console.log('\nAFTER:')
  console.log(`  incorporated markers: ${afterMarkers} (expected ${represented.length})`)
  console.log(`  unincorporated captures: ${afterUnincorporated} (expected ${unrepresented.length} = the genuinely-new captures)`)
  console.log(`  corrections_fp: ${afterFp ?? '(none)'}`)
  const okMarkers = afterMarkers === represented.length
  const okUnincorporated = afterUnincorporated === unrepresented.length
  const okFp = !willSeedFp || afterFp === fingerprint
  console.log(`\nVERDICT: ${okMarkers && okUnincorporated && okFp ? 'OK -> next mine is INCREMENTAL over the new captures' : 'MISMATCH -> investigate'}`)
  if (!(okMarkers && okUnincorporated && okFp)) process.exit(1)
}

// ---- helpers ----------------------------------------------------------------
function esc(s) {
  return String(s).replace(/'/g, "''")
}
function sql(query) {
  const body = JSON.stringify({ query })
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: 'api.supabase.com', path: `/v1/projects/${REF}/database/query`, method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let t = ''
        res.on('data', (c) => (t += c))
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(t)) : reject(new Error(`Management API ${res.statusCode}: ${t.slice(0, 400)}`))))
      }
    )
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}
async function scalar(query) {
  const r = await sql(query)
  const row = r[0] ?? {}
  const k = Object.keys(row)[0]
  return row[k]
}
function loadEnvLocal() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch {}
}
function need(name) {
  const v = process.env[name]
  if (!v) fail(`${name} is not set (needs SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN)`)
  return v
}
function fail(msg) {
  console.error('[seed] ' + msg)
  process.exit(2)
}

main().catch((e) => {
  console.error('[seed] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
