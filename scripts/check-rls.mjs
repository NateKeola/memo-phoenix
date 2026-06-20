// B1: reusable RLS-state audit (the security guard). Enumerates every relation in
// the public schema from the LIVE database and asserts the multi-user boundary:
//   - every TABLE has RLS enabled AND forced (so even the owner role is subject to policy)
//   - every table has at least a per-user SELECT policy scoping to user_id = auth.uid()
//   - no policy is permissive across users (no `using (true)`, no role public)
//   - every VIEW is security_invoker (so it cannot bypass the underlying RLS)
//   - the only SECURITY DEFINER function is the row-local history trigger
//   - the client roles (anon, authenticated) do NOT have bypassrls
//
// Exit non-zero on any failure, so it can gate CI / be re-run after every schema
// change. Uses the Supabase Management API over node:https (no CLI, no pg driver;
// global fetch misbehaves in some local envs). Needs SUPABASE_PROJECT_REF +
// SUPABASE_ACCESS_TOKEN (see docs/MIGRATIONS.md).
//
// Run: node scripts/check-rls.mjs
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const REF = process.env.SUPABASE_PROJECT_REF
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
if (!REF || !TOKEN) { console.error('need SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN in .env.local'); process.exit(2) }

function sql(query) {
  const body = JSON.stringify({ query })
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: 'api.supabase.com', path: `/v1/projects/${REF}/database/query`, method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`MgmtAPI ${res.statusCode}: ${t.slice(0, 300)}`))
        try { resolve(JSON.parse(t)) } catch { resolve([]) } }) })
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.on('error', reject); req.end(body)
  })
}

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`  ok   ${n}`) }
const bad = (n, d = '') => { fail++; console.log(`  FAIL ${n} ${d}`) }

const rels = await sql(`
  select c.relname as name, c.relkind as kind, c.relrowsecurity as rls_enabled,
    c.relforcerowsecurity as rls_forced, coalesce(array_to_string(c.reloptions, ','), '') as reloptions
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','v','m','p') order by c.relname;`)
const pols = await sql(`
  select tablename, cmd, array_to_string(roles, ',') as roles, permissive,
    coalesce(qual,'') as using_expr, coalesce(with_check,'') as check_expr
  from pg_policies where schemaname = 'public';`)
const fns = await sql(`select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';`)
const roles = await sql(`select rolname, rolbypassrls from pg_roles where rolname in ('anon','authenticated');`)

const tables = rels.filter((r) => r.kind === 'r' || r.kind === 'p')
const views = rels.filter((r) => r.kind === 'v' || r.kind === 'm')
const polByTable = {}
for (const p of pols) (polByTable[p.tablename] ||= []).push(p)

console.log(`project ${REF}: ${tables.length} tables, ${views.length} views, ${pols.length} policies\n`)

console.log('== every table has RLS enabled AND forced ==')
for (const t of tables) {
  if (t.rls_enabled && t.rls_forced) ok(`${t.name} RLS enabled+forced`)
  else bad(`${t.name} RLS`, `enabled=${t.rls_enabled} forced=${t.rls_forced}`)
}

console.log('\n== every table has a per-user policy; none permissive across users ==')
for (const t of tables) {
  const ps = polByTable[t.name] || []
  if (ps.length === 0) { bad(`${t.name} has no policy`); continue }
  let okScoped = true, why = ''
  for (const p of ps) {
    const exprs = `${p.using_expr} ${p.check_expr}`
    const scoped = /user_id = auth\.uid\(\)/.test(exprs)
    const leaky = /\b(using )?\(?true\)?/.test(p.using_expr.trim()) && !/user_id/.test(p.using_expr)
    const pub = /(^|,)(public|anon)(,|$)/.test(p.roles)
    if (!scoped) { okScoped = false; why = `${p.cmd} not scoped to user_id=auth.uid() (using=${p.using_expr} check=${p.check_expr})` }
    if (leaky) { okScoped = false; why = `${p.cmd} permissive using(true)` }
    if (pub) { okScoped = false; why = `${p.cmd} granted to ${p.roles}` }
  }
  if (okScoped) ok(`${t.name} policies all per-user (${ps.map((p) => p.cmd).join('/')})`)
  else bad(`${t.name} policy`, why)
}

console.log('\n== views are security_invoker (cannot bypass underlying RLS) ==')
for (const v of views) {
  if (/security_invoker=(true|on)/i.test(v.reloptions)) ok(`${v.name} security_invoker`)
  else bad(`${v.name} NOT security_invoker`, `reloptions=[${v.reloptions}]`)
}

console.log('\n== SECURITY DEFINER functions are only the row-local history trigger ==')
const secdef = fns.filter((f) => f.prosecdef).map((f) => f.proname).sort()
if (JSON.stringify(secdef) === JSON.stringify(['snapshot_canonical'])) ok('only snapshot_canonical is SECURITY DEFINER')
else bad('unexpected SECURITY DEFINER functions', secdef.join(',') || 'none')

console.log('\n== client roles cannot bypass RLS ==')
for (const r of roles) {
  if (!r.rolbypassrls) ok(`${r.rolname} bypassrls=false`)
  else bad(`${r.rolname} HAS bypassrls`, 'client role can bypass RLS!')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
