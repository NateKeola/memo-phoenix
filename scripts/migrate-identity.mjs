#!/usr/bin/env node
// Deterministic-id hardening: the DATA migration onto stable identity.
//
// SAFETY BOUNDARY: by default this is a READ-ONLY DRY RUN. It reports exactly what
// it would change (alias-seed counts + a sample, and pre-existing duplicate clusters
// past label drift may have split) and writes NOTHING. Applying it to the real graph
// is a deliberate, backed-up step the operator runs after reviewing the PR. This file
// is NOT run with --apply against the dev database in the hardening PR.
//
// The scheme keeps existing canonical row ids as their stable ids (no re-key), so the
// "migration" is additive: it SEEDS entity_aliases from current labels + aliases +
// corrections so a later mention of an old/drifted label resolves to the right id
// from day one. (The miner also self-seeds at resolve time, so seeding is an
// optimization, not a correctness prerequisite.) Duplicate clusters are REPORTED for
// the operator to optionally collapse; collapse is the only genuinely destructive
// re-key and is left as a reviewed manual step, not auto-applied.
//
// Zero-dependency (node:https + the Supabase Management API), so it runs under the
// local tsx/fetch wedge, like db.mjs / check-rls.mjs.
//
// Usage:
//   node scripts/migrate-identity.mjs              dry run (read-only report)
//   node scripts/migrate-identity.mjs --apply-seed seed entity_aliases (operator, after backup)
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---- pure planning (exported for scripts/check-identity-migration.mjs) -------

export function normLabel(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}
export function toks(s) {
  const out = new Set()
  for (const t of normLabel(s).split(/[^a-z0-9]+/)) if (t) out.add(t)
  return out
}
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const uni = a.size + b.size - inter
  return uni === 0 ? 0 : inter / uni
}

// Tables whose identity is label/statement-keyed (so a drift needs an alias).
// Relationships are endpoint-keyed: they stabilize for free once node ids are
// stable, so they are not seeded here.
export const SEED_TABLES = [
  'canonical_people',
  'canonical_places_orgs',
  'canonical_projects',
  'canonical_events',
  'canonical_facts',
  'canonical_commitments',
  'insights',
]

function labelBasis(table, row) {
  const d = row.data ?? {}
  if (table === 'insights') return d.statement ?? row.label
  return row.label
}

// Build the alias-seed plan: for each current row, its normalized label + each of
// its stored aliases (and statement for insights) map to that row's stable id.
// Corrections add the old/from label -> the survivor row's id. Reports collisions
// (one normalized alias claimed by two different ids = a pre-existing duplicate).
export function planSeedAliases(rowsByTable, corrections) {
  const aliasRows = []
  const seen = new Map() // `${user}|${table}|${alias}` -> stable_id
  const collisions = []
  const counts = {}

  const add = (user_id, entity_table, alias_norm, stable_id, source) => {
    if (!alias_norm) return
    const key = `${user_id}|${entity_table}|${alias_norm}`
    const prior = seen.get(key)
    if (prior && prior !== stable_id) {
      collisions.push({ user_id, entity_table, alias_norm, ids: [prior, stable_id] })
      return
    }
    if (prior === stable_id) return
    seen.set(key, stable_id)
    aliasRows.push({ user_id, entity_table, alias_norm, stable_id, source })
    counts[entity_table] = (counts[entity_table] ?? 0) + 1
  }

  for (const table of SEED_TABLES) {
    for (const row of rowsByTable[table] ?? []) {
      const basis = labelBasis(table, row)
      add(row.user_id, table, normLabel(basis), row.id, 'seed')
      const aliases = Array.isArray(row.data?.aliases) ? row.data.aliases : []
      for (const a of aliases) if (typeof a === 'string') add(row.user_id, table, normLabel(a), row.id, 'seed')
    }
  }

  // corrections (rename_person / merge_people): from-label -> survivor person id
  const peopleByLabel = new Map()
  for (const row of rowsByTable['canonical_people'] ?? []) {
    peopleByLabel.set(`${row.user_id}|${normLabel(row.label)}`, row.id)
  }
  for (const c of corrections) {
    if (c.kind !== 'rename_person' && c.kind !== 'merge_people') continue
    const p = c.payload ?? {}
    const from = p.from_label ?? p.from
    const to = c.kind === 'merge_people' ? p.into_label ?? p.into : p.to_label ?? p.to
    if (!from || !to) continue
    const survivorId = peopleByLabel.get(`${c.user_id}|${normLabel(to)}`)
    if (survivorId) add(c.user_id, 'canonical_people', normLabel(from), survivorId, 'correction')
  }

  return { aliasRows, collisions, counts }
}

// Find pre-existing duplicate clusters: current rows in the same (user, table) whose
// labels fuzzy-match above the threshold. These are entities a past label drift may
// have split into separate rows. Reported for the operator to optionally collapse.
export function findDuplicateClusters(rowsByTable, threshold = 0.8) {
  const clusters = []
  for (const table of SEED_TABLES) {
    const byUser = new Map()
    for (const row of rowsByTable[table] ?? []) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, [])
      byUser.get(row.user_id).push({ id: row.id, label: labelBasis(table, row), toks: toks(labelBasis(table, row)) })
    }
    for (const [user_id, rows] of byUser) {
      const used = new Set()
      for (let i = 0; i < rows.length; i++) {
        if (used.has(i)) continue
        const group = [rows[i]]
        for (let j = i + 1; j < rows.length; j++) {
          if (used.has(j)) continue
          if (jaccard(rows[i].toks, rows[j].toks) >= threshold) {
            group.push(rows[j])
            used.add(j)
          }
        }
        if (group.length > 1) {
          used.add(i)
          clusters.push({ user_id, table, members: group.map((g) => ({ id: g.id, label: g.label })) })
        }
      }
    }
  }
  return clusters
}

// ---- DB I/O (Management API; only used when run as a CLI) --------------------

function loadEnv(root) {
  try {
    for (const line of readFileSync(join(root, '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch {
    /* rely on real env */
  }
}

function sql(query) {
  const ref = process.env.SUPABASE_PROJECT_REF
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const body = JSON.stringify({ query })
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: 'api.supabase.com',
        path: `/v1/projects/${ref}/database/query`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let t = ''
        res.on('data', (c) => (t += c))
        res.on('end', () =>
          res.statusCode < 300 ? resolve(JSON.parse(t || '[]')) : reject(new Error(`${res.statusCode}: ${t.slice(0, 300)}`))
        )
      }
    )
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  loadEnv(root)
  if (!process.env.SUPABASE_PROJECT_REF || !process.env.SUPABASE_ACCESS_TOKEN) {
    console.error('need SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN in .env.local')
    process.exit(2)
  }
  const applySeed = process.argv.includes('--apply-seed')

  const rowsByTable = {}
  for (const table of SEED_TABLES) {
    rowsByTable[table] = await sql(
      `select id, user_id, label, data from public.${table} where valid_to is null`
    )
  }
  const corrections = await sql(
    `select user_id, kind, payload from public.corrections where kind in ('rename_person','merge_people')`
  )

  const { aliasRows, collisions, counts } = planSeedAliases(rowsByTable, corrections)
  const clusters = findDuplicateClusters(rowsByTable)

  console.log(`\n=== identity migration ${applySeed ? '(APPLY SEED)' : '(DRY RUN, read-only)'} ===`)
  let totalRows = 0
  for (const table of SEED_TABLES) {
    const n = (rowsByTable[table] ?? []).length
    totalRows += n
    console.log(`  ${table.padEnd(24)} rows=${String(n).padStart(4)}  aliases to seed=${counts[table] ?? 0}`)
  }
  console.log(`\n  total current rows: ${totalRows}`)
  console.log(`  total alias rows to seed: ${aliasRows.length}`)
  console.log('  sample seed mappings:')
  for (const a of aliasRows.slice(0, 8)) console.log(`    [${a.entity_table}] "${a.alias_norm}" -> ${a.stable_id} (${a.source})`)

  console.log(`\n  alias collisions (one normalized label, two ids = pre-existing duplicate): ${collisions.length}`)
  for (const c of collisions.slice(0, 8)) console.log(`    [${c.entity_table}] "${c.alias_norm}" -> ${c.ids.join(' , ')}`)

  console.log(`\n  duplicate clusters (fuzzy-similar current rows a drift may have split): ${clusters.length}`)
  for (const cl of clusters.slice(0, 8)) {
    console.log(`    [${cl.table}] ${cl.members.map((m) => `"${m.label}"`).join('  ~  ')}`)
  }

  if (!applySeed) {
    console.log('\nDRY RUN: nothing written. Re-run with --apply-seed (after a backup) to seed entity_aliases.')
    console.log('Duplicate-cluster COLLAPSE is intentionally NOT automated here; review and collapse deliberately.')
    return
  }

  // --apply-seed: insert alias rows idempotently. (Operator path; not run on dev in the PR.)
  console.log(`\nApplying ${aliasRows.length} alias rows...`)
  for (let i = 0; i < aliasRows.length; i += 200) {
    const chunk = aliasRows.slice(i, i + 200)
    const values = chunk
      .map(
        (a) =>
          `('${a.user_id}','${a.entity_table}',${lit(a.alias_norm)},'${a.stable_id}',${lit(a.source)})`
      )
      .join(',')
    await sql(
      `insert into public.entity_aliases (user_id, entity_table, alias_norm, stable_id, source) values ${values}
       on conflict (user_id, entity_table, alias_norm) do nothing;`
    )
  }
  console.log('Seed applied. Duplicate clusters were reported only; collapse them deliberately.')
}

function lit(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// Run as a CLI only when invoked directly (so the test can import the planners).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error('\n[migrate-identity] error:', e instanceof Error ? e.message : String(e))
    process.exit(2)
  })
}
