#!/usr/bin/env node
// CLI-independent migration tool. Does NOT use the Supabase CLI (which has been
// failing to connect from some machines) and needs NO database password and NO
// `pg` driver. It talks to the Supabase Management API
// (POST /v1/projects/{ref}/database/query), which runs SQL over HTTPS as the
// database owner, so it can apply DDL.
//
// Credentials (the SAME two the migrate workflow needs):
//   SUPABASE_PROJECT_REF    e.g. azlobwtiptvarfeukzcv
//   SUPABASE_ACCESS_TOKEN   a Supabase personal access token (account -> Access Tokens)
// Both are read from the environment, falling back to .env.local for local use.
//
// Usage:
//   node scripts/db.mjs status            report applied vs pending (npm run db:status)
//   node scripts/db.mjs status --check    same, but exit 1 if anything is pending (the guard)
//   node scripts/db.mjs apply             apply pending migrations in order (npm run db:apply)
//
// The applied set is read from supabase_migrations.schema_migrations (the same
// table the Supabase CLI uses), and apply records each migration there with the
// version = the filename prefix before the first underscore, so `supabase db push`
// and this tool agree on what is applied.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { request as httpsRequest } from 'node:https'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
// Host only. We use the built-in https module rather than global fetch because in
// some local environments undici's fetch throws "Failed to parse URL" for valid
// URLs, which would defeat the whole point of a CLI-independent fallback.
const API_HOST = process.env.SUPABASE_API_HOST || 'api.supabase.com'

function loadEnvLocal() {
  try {
    for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      // .trim() also strips a trailing \r when .env.local has CRLF line endings,
      // which would otherwise corrupt the bearer token and the project ref.
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch {
    // no .env.local; rely on real env (CI)
  }
}

function need(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`\n[db] ${name} is not set.`)
    console.error('     This tool needs SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN.')
    console.error('     See docs/MIGRATIONS.md (Applying migrations) for how to get them.')
    process.exit(2)
  }
  return v
}

function runSql(query) {
  const ref = need('SUPABASE_PROJECT_REF')
  const token = need('SUPABASE_ACCESS_TOKEN')
  const body = JSON.stringify({ query })
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: API_HOST,
        path: `/v1/projects/${ref}/database/query`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Management API ${res.statusCode}: ${text.slice(0, 500)}`))
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch {
            resolve([])
          }
        })
      }
    )
    req.setTimeout(30000, () => {
      req.destroy(new Error('Management API request timed out after 30s'))
    })
    req.on('error', reject)
    req.end(body)
  })
}

// version = the prefix before the first underscore (matches the Supabase CLI).
function localMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const base = file.replace(/\.sql$/, '')
      const us = base.indexOf('_')
      const version = us === -1 ? base : base.slice(0, us)
      const name = us === -1 ? '' : base.slice(us + 1)
      return { file, version, name, path: join(MIGRATIONS_DIR, file) }
    })
}

async function appliedVersions() {
  // Ensure the bookkeeping table exists so a fresh project reports cleanly instead
  // of erroring. This matches what the Supabase CLI creates.
  await runSql(
    `create schema if not exists supabase_migrations;
     create table if not exists supabase_migrations.schema_migrations (
       version text primary key, name text, statements text[], inserted_at timestamptz default now());`
  )
  const rows = await runSql(`select version from supabase_migrations.schema_migrations order by version;`)
  return new Set((rows || []).map((r) => String(r.version)))
}

function report(list) {
  console.log(`\nRemote project: ${process.env.SUPABASE_PROJECT_REF}`)
  console.log(`Local migration files: ${list.length}\n`)
  for (const m of list) console.log(`  ${m.applied ? 'APPLIED' : 'PENDING'}   ${m.version.padEnd(6)} ${m.file}`)
  const pending = list.filter((m) => !m.applied)
  const applied = list.length - pending.length
  console.log(`\nSummary: ${applied} applied, ${pending.length} pending.`)
  if (pending.length) console.log(`Pending: ${pending.map((m) => m.file).join(', ')}`)
  else console.log('Up to date.')
  return pending
}

async function status(check) {
  const applied = await appliedVersions()
  const list = localMigrations().map((m) => ({ ...m, applied: applied.has(m.version) }))
  const pending = report(list)
  if (check && pending.length) {
    console.error(
      `\n[db] GUARD FAILED: ${pending.length} migration(s) are NOT applied on the remote: ${pending
        .map((m) => m.file)
        .join(', ')}.`
    )
    console.error('     Code that depends on these must not ship. Run `npm run db:apply` (or fix the migrate workflow).')
    process.exit(1)
  }
}

async function apply() {
  const applied = await appliedVersions()
  const pending = localMigrations().filter((m) => !applied.has(m.version))
  if (!pending.length) {
    console.log('\nUp to date. Nothing to apply.')
    return
  }
  console.log(`\nApplying ${pending.length} pending migration(s) to ${process.env.SUPABASE_PROJECT_REF}...\n`)
  for (const m of pending) {
    const sql = readFileSync(m.path, 'utf8')
    process.stdout.write(`  ${m.version} ${m.file} ... `)
    const record = `insert into supabase_migrations.schema_migrations (version, name) values ('${m.version}', '${m.name.replace(
      /'/g,
      "''"
    )}') on conflict (version) do nothing;`
    // Run the migration then record it. Migrations are written idempotently
    // (if not exists / add column if not exists / drop ... if exists), so a retry
    // after a partial failure is safe.
    await runSql(`${sql}\n${record}`)
    console.log('done')
  }
  console.log('\nApplied. Run `npm run db:status` to confirm.')
}

loadEnvLocal()
const cmd = process.argv[2]
const check = process.argv.includes('--check')
;(async () => {
  try {
    if (cmd === 'status') await status(check)
    else if (cmd === 'apply') await apply()
    else {
      console.error('usage: node scripts/db.mjs <status|apply> [--check]')
      process.exit(2)
    }
  } catch (e) {
    console.error('\n[db] error:', e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
})()
