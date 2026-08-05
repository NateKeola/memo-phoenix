// Orphan guard. Asserts that no per-user table holds a row whose user_id is absent
// from auth.users.
//
// WHY IT EXISTS: an orphan row is unreachable forever (every RLS policy here reads
// user_id = auth.uid(), and a deleted user cannot authenticate) and it blocks the
// Phase 1 scope backfill, which sets scope_id NOT NULL by joining user_id to that
// user's personal scope. 578 such rows accumulated because two security guards
// created and then deleted throwaway auth users after seeding canonical rows, and
// the resulting canonical_history rows are hard append-only.
//
// SCHEMA SCOPE IS LOAD BEARING. This script enumerates tables from
// information_schema.tables WHERE table_schema = 'public' and nothing else. It must
// NEVER scan all schemas, and the table list must NEVER become a hardcoded array
// someone extends later. The reason is specific: audit_backup holds the archived
// orphan rows, 578 of them, whose user_id is absent from auth.users BY DESIGN. A
// scanner that reaches audit_backup would report 578 orphans permanently and the
// Phase 1 gate could never pass. The assertion below enforces this from inside the
// script rather than trusting the query to stay correct.
//
// Read-only. Safe to run repeatedly.
//
// Run: npx tsx scripts/check-orphans.ts     (npm run check:orphans)
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
try {
  for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
} catch {
  // rely on the real environment (CI)
}

const REF = process.env.SUPABASE_PROJECT_REF
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
if (!REF || !TOKEN) {
  console.error('need SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN (see docs/MIGRATIONS.md)')
  process.exit(2)
}

// node:https rather than global fetch: undici throws "Failed to parse URL" for valid
// URLs in some local environments, which is why every live guard here avoids fetch.
function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const body = JSON.stringify({ query })
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      {
        host: 'api.supabase.com',
        path: `/v1/projects/${REF}/database/query`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let t = ''
        res.on('data', (c) => (t += c))
        res.on('end', () => {
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(new Error(`Management API ${res.statusCode}: ${t.slice(0, 400)}`))
            return
          }
          try { resolve(JSON.parse(t) as T[]) } catch { resolve([] as T[]) }
        })
      }
    )
    r.setTimeout(60000, () => r.destroy(new Error('timed out')))
    r.on('error', reject)
    r.end(body)
  })
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

type TableRow = { table_schema: string; table_name: string }
type CountRow = { n: number | string }

async function main(): Promise<void> {
  console.log(`project ${REF}: orphan scan\n`)

  // PUBLIC ONLY. Explicit predicate, not a hardcoded list. Every per-user table is
  // discovered by having a user_id column, so a table added later is covered
  // automatically without anyone remembering to extend an array.
  const tables = await sql<TableRow>(`
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'user_id'
      and t.table_type = 'BASE TABLE'
    order by c.table_name;`)

  // THE SCHEMA ASSERTION. If the query above is ever loosened, or a future edit
  // widens it to all schemas, this stops the run rather than producing a permanently
  // failing orphan count from audit_backup's archived rows.
  const strays = tables.filter((t) => t.table_schema !== 'public')
  if (strays.length > 0) {
    console.error('\nFATAL: the table enumeration returned tables outside the public schema:')
    for (const s of strays) console.error(`  ${s.table_schema}.${s.table_name}`)
    console.error('\nThis scanner must only ever scan public. audit_backup holds archived rows whose')
    console.error('user_id is absent from auth.users BY DESIGN; scanning it would report permanent')
    console.error('false orphans and the Phase 1 gate could never pass. Fix the query, do not')
    console.error('relax the orphan assertion.')
    process.exit(1)
  }
  console.log(`scanning ${tables.length} public tables carrying user_id (audit_backup excluded by construction)\n`)

  let totalOrphans = 0
  for (const t of tables) {
    const rows = await sql<CountRow>(`
      select count(*) as n from public.${t.table_name} x
      where x.user_id is not null
        and not exists (select 1 from auth.users u where u.id = x.user_id);`)
    const n = Number(rows[0]?.n ?? 0)
    totalOrphans += n
    check(`${t.table_name} has 0 orphan rows`, n === 0, `found ${n}`)
  }

  console.log(`\n${pass} passed, ${fail} failed, ${totalOrphans} orphan rows total`)
  if (totalOrphans > 0) {
    console.log('\nAn orphan row is unreachable forever and blocks the Phase 1 scope backfill.')
    console.log('Do not relax this check. Find what deleted an auth.users row: see the standing')
    console.log('rule in CLAUDE.md (never hard-delete a row from auth.users).')
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('ERROR', e); process.exit(1) })
