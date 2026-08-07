// Phase 2 acceptance smoke for the durable observability layer (migration 0018).
// Exercises the REAL store on the dev DB end to end and self-cleans:
//   1. writes a HEALTHY event (scribe transcribe_ok) and a FORCED-FAILURE event
//      (scribe transcribe_error with error type + message),
//   2. reads them back exactly as the admin console does (newest-first select),
//   3. rolls up subsystem health the same way lib/observability.ts does and asserts
//      the healthy signal reads healthy and the failure surfaces WITH detail,
//   4. asserts PRIVACY: the only columns are the shaped ones and meta carries only
//      whitelisted-shaped keys (no content column exists to hold a transcript/body),
//   5. deletes the test rows and confirms zero residue.
//
// Self-contained node:https to the Supabase Management API (no CLI, no pg, no tsx),
// so it runs under the local tsx/fetch wedge and in CI. Needs SUPABASE_PROJECT_REF +
// SUPABASE_ACCESS_TOKEN in .env.local (see docs/MIGRATIONS.md).
//
// Run: node scripts/check-obs-db.mjs
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const REF = process.env.SUPABASE_PROJECT_REF
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
if (!REF || !TOKEN) {
  console.error('need SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN in .env.local')
  process.exit(2)
}

function sql(query) {
  const body = JSON.stringify({ query })
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: 'api.supabase.com',
        path: `/v1/projects/${REF}/database/query`,
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let t = ''
        res.on('data', (c) => (t += c))
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`MgmtAPI ${res.statusCode}: ${t.slice(0, 300)}`))
          try {
            resolve(JSON.parse(t))
          } catch {
            resolve([])
          }
        })
      }
    )
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

let pass = 0,
  fail = 0
const ok = (n) => {
  pass++
  console.log(`  ok   ${n}`)
}
const bad = (n, d = '') => {
  fail++
  console.log(`  FAIL ${n} ${d}`)
}

const TAG = `obs-smoke-${randomUUID()}`
const q = (s) => s.replace(/'/g, "''")

try {
  console.log(`observability store smoke (tag ${TAG})\n`)

  // 1. write a healthy event and a forced-failure event, both tagged for cleanup.
  await sql(`
    insert into public.observability_events (subsystem, event, level, status, duration_ms, meta)
    values ('scribe', 'transcribe_ok', 'info', 'ok', 1234,
            jsonb_build_object('smoke','${q(TAG)}','bytes',20480,'chars',412,'contentType','audio/webm'));`)
  await sql(`
    insert into public.observability_events (subsystem, event, level, status, duration_ms, error_type, error_message, meta)
    values ('scribe', 'transcribe_error', 'error', 'error', 87,
            'ScribeSmokeError', 'forced failure for the observability smoke (no content)',
            jsonb_build_object('smoke','${q(TAG)}','bytes',20480,'contentType','audio/webm'));`)
  ok('wrote a healthy event and a forced-failure event')

  // 2. read them back newest-first, exactly as readRecentObs() does.
  const rows = await sql(`
    select id, user_id, subsystem, event, level, status, duration_ms, error_type, error_message, meta, created_at
    from public.observability_events
    where meta->>'smoke' = '${q(TAG)}'
    order by created_at desc;`)
  if (rows.length === 2) ok('read both events back through the store')
  else bad('expected 2 rows back', `got ${rows.length}`)

  const healthy = rows.find((r) => r.event === 'transcribe_ok')
  const failure = rows.find((r) => r.event === 'transcribe_error')

  // 3. the healthy signal has no error detail; the failure surfaces WITH detail.
  if (healthy && healthy.level === 'info' && !healthy.error_type && !healthy.error_message) ok('healthy event carries no error detail')
  else bad('healthy event shape wrong', JSON.stringify(healthy))
  if (failure && failure.level === 'error' && failure.error_type === 'ScribeSmokeError' && /forced failure/.test(failure.error_message || '')) {
    ok('forced failure surfaces with error type + message')
  } else bad('failure detail missing', JSON.stringify(failure))
  if (failure && typeof failure.duration_ms === 'number') ok('timing recorded on the failure (duration_ms)')
  else bad('failure missing timing')

  // rollUpHealth parity: scribe has an error in the last hour -> unhealthy, and the
  // last error message is exposed (this is exactly what the console shows).
  const nowMs = Date.now()
  const hourAgo = nowMs - 60 * 60 * 1000
  const scribeRows = rows.filter((r) => r.subsystem === 'scribe')
  const recentErrs = scribeRows.filter((r) => r.level === 'error' && new Date(r.created_at).getTime() >= hourAgo)
  if (recentErrs.length === 1) ok('health rollup: scribe reads UNHEALTHY (1 error in last hour)')
  else bad('health rollup wrong', `recentErrs=${recentErrs.length}`)
  if (recentErrs[0]?.error_message) ok('health rollup exposes the last error message to the console')
  else bad('health rollup lost the error message')

  // 4. PRIVACY: the table has ONLY shaped columns (no body/transcript column can
  // exist to hold content), and meta carries only shaped keys we put.
  const cols = (
    await sql(`
      select column_name from information_schema.columns
      where table_schema='public' and table_name='observability_events' order by column_name;`)
  ).map((r) => r.column_name)
  const expected = ['created_at', 'duration_ms', 'error_message', 'error_type', 'event', 'id', 'level', 'meta', 'status', 'subsystem', 'user_id']
  if (JSON.stringify(cols.sort()) === JSON.stringify(expected)) ok('schema is shaped-only (no content/body/transcript column)')
  else bad('unexpected columns', cols.join(','))
  const metaObj = failure?.meta || {}
  // A transcript / capture body is LONG free text; shaped metadata (counts, MIME
  // types, states, flags) is short. The real privacy property is that no meta value
  // is long enough to carry content (the writer truncates strings at 120).
  const longVals = Object.entries(metaObj).filter(([, v]) => typeof v === 'string' && v.length > 120)
  if (longVals.length === 0) ok('meta values are all short/shaped (no long free text to carry content)')
  else bad('meta has long string values', longVals.map(([k]) => k).join(','))
  // and no meta key is a reserved content key (exact match, so contentType/MIME is fine)
  const bannedKeys = Object.keys(metaObj).filter((k) => /^(transcript|body|prompt|content|answer|question|message)$/i.test(k))
  if (bannedKeys.length === 0) ok('meta has no content-bearing key name')
  else bad('meta has a content-bearing key', bannedKeys.join(','))

  // 4b. PRIVACY, miner per-model-call telemetry (event_type='llm_call').
  // These rows are written by packages/miner-core/src/call-telemetry.ts, one per model
  // call. The model's response text summarizes real people, so it is user content: it
  // goes to stdout only (the Action log) and must never reach a table. The emitter
  // filters through LLM_CALL_ATTR_KEYS; these assertions prove the property holds on
  // the rows that actually landed. They are inert until the first mine writes some,
  // and load-bearing from then on. Keep this list in sync with LLM_CALL_ATTR_KEYS.
  const LLM_CALL_ATTR_KEYS = [
    'pass', 'ctx', 'batch', 'attempt', 'attempts_allowed',
    'batch_limit', 'claims_sent', 'already_emitted_sent', 'user_chars',
    'stop_reason', 'text_chars', 'block_count', 'block_types', 'items_returned',
    'tokens_in', 'tokens_out', 'tokens_thinking', 'cache_read', 'cache_write', 'duration_ms',
    'outcome', 'error_class', 'rejected_claim_id',
  ]
  // The scan, factored out so it can be exercised on a known-dirty row below. Returns
  // the violations found, so an empty result is a pass.
  const scanLlmCallRows = (rows) => {
    const stray = new Set()
    const banned = new Set()
    const long = new Set()
    for (const row of rows) {
      for (const [k, v] of Object.entries(row.attrs || {})) {
        if (!LLM_CALL_ATTR_KEYS.includes(k)) stray.add(k)
        if (/^(transcript|body|prompt|content|answer|question|message|summary|label|text|raw)$/i.test(k)) banned.add(k)
        // model output is LONG free text; every legitimate attr here is an id, a count,
        // an enum, or a short array of block-type names.
        if (typeof v === 'string' && v.length > 120) long.add(k)
        if (Array.isArray(v) && v.some((x) => typeof x === 'string' && x.length > 120)) long.add(k)
      }
    }
    return { stray: [...stray], banned: [...banned], long: [...long] }
  }

  // Prove the scan is not a no-op BEFORE trusting it on live rows: a row carrying a
  // slab of model prose under a plausible key must be caught on all three axes.
  // In-memory only; nothing is written to any table.
  const dirty = scanLlmCallRows([
    { attrs: { pass: 'canonical_people', summary: 'Mal Corpus is one of the oldest friends from the surf club. '.repeat(4) } },
  ])
  if (dirty.stray.includes('summary') && dirty.banned.includes('summary') && dirty.long.includes('summary')) {
    ok('llm_call privacy scan catches a planted model-output attr (assertion is not vacuous)')
  } else bad('llm_call privacy scan failed to catch planted content', JSON.stringify(dirty))

  const callRows = await sql(`
    select name, attrs from public.telemetry_events
    where event_type = 'llm_call' order by created_at desc limit 500;`)
  const found = scanLlmCallRows(callRows)
  ok(`llm_call telemetry readable (${callRows.length} row(s) present)`)
  if (found.stray.length === 0) ok('llm_call attrs carry only whitelisted shaped keys')
  else bad('llm_call attrs have keys outside the whitelist', found.stray.join(','))
  if (found.banned.length === 0) ok('llm_call attrs have no content-bearing key name')
  else bad('llm_call attrs have a content-bearing key', found.banned.join(','))
  if (found.long.length === 0) ok('llm_call attrs are all short/shaped (no model output can be hiding in them)')
  else bad('llm_call attrs have long string values', found.long.join(','))

  // The highest-risk column is miner_runs.error, because mineWithLock persists a thrown
  // Error message there. parseModelObject used to embed a 200-character slice of the
  // model's response in that message, which put user content (summaries of real people)
  // into the database. It now embeds shaped metadata and prints the full text to stdout.
  //
  // Rows written by the NEW format are identifiable by the stdout marker. We assert the
  // property only on those, because rows predating this change still carry a slice and
  // are ground truth we do not rewrite. The historical count is surfaced, not failed on.
  const errRows = await sql(`
    select coalesce(error, '') as error from public.miner_runs
    where error is not null and error <> '' order by started_at desc limit 100;`)
  const STDOUT_MARKER = 'full output printed to stdout'
  const newFormat = errRows.filter((r) => r.error.includes(STDOUT_MARKER))
  const newFormatLeaking = newFormat.filter((r) => /valid JSON \(.*\)\s*:\s*[{[]/s.test(r.error))
  if (newFormatLeaking.length === 0) ok(`miner_runs.error: no new-format row carries a model-output slice (${newFormat.length} new-format row(s))`)
  else bad('miner_runs.error carries model output', `${newFormatLeaking.length} new-format row(s)`)
  const legacyLeaking = errRows.filter((r) => !r.error.includes(STDOUT_MARKER) && /valid JSON \(.*\)\s*:\s*[{[]/s.test(r.error))
  ok(`miner_runs.error: ${legacyLeaking.length} legacy row(s) predating this change still carry a slice (reported, not rewritten)`)

  // 5. clean up and confirm zero residue.
  await sql(`delete from public.observability_events where meta->>'smoke' = '${q(TAG)}';`)
  const left = await sql(`select count(*)::int as n from public.observability_events where meta->>'smoke' = '${q(TAG)}';`)
  if ((left[0]?.n ?? -1) === 0) ok('test rows deleted (no residue)')
  else bad('residue left', `n=${left[0]?.n}`)
} catch (e) {
  bad('smoke threw', e instanceof Error ? e.message : String(e))
  // best-effort cleanup on failure
  try {
    await sql(`delete from public.observability_events where meta->>'smoke' = '${q(TAG)}';`)
  } catch {
    /* ignore */
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
