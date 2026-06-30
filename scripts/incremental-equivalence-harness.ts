// Live equivalence + perf harness for the incremental miner (the pre-flip cutover
// gate). Operator-run, NOT CI: it uses the real DB and the real model, so it costs
// API and takes time. Scoped entirely to dedicated THROWAWAY test users; it never
// touches the real user. Append-only residue on the throwaway users is acceptable;
// the harness performs NO hard deletes.
//
// It answers the two questions the deterministic merge gate (scripts/check-incremental.ts)
// could not: does incremental land structurally the same graph a full recompute does
// (judged against the LLM-nondeterminism floor of full-vs-full), and how much faster /
// cheaper is an incremental fold than a full recompute.
//
//   - userD (FULL, MINER_INCREMENTAL=0): full-mine the whole corpus -> snapshot D1;
//     bust the derive-memo (an UPDATE, never a delete) and full re-derive -> D2.
//     NOISE FLOOR = D1 vs D2 (two independent full derivations of the same corpus).
//   - userC (INCREMENTAL, MINER_INCREMENTAL=1): mine the first ~70% of captures (the
//     first run seeds the markers, so it runs the FULL baseline branch), then add the
//     remaining ~30% and mine again (the INCREMENTAL fold) -> snapshot C.
//   - EQUIVALENCE = C vs D2, judged against the noise floor.
//
// Ids are uuidv5 over (user_id, table, normalized label), so they differ per user;
// the structural diff therefore keys on the NORMALIZED LABEL (and, for edges, the
// resolved endpoint labels), which is comparable across users. Coverage is a per-user
// metric (every raw claim cited by some current canonical row).
//
// Run (operator, dev): npx tsx scripts/incremental-equivalence-harness.ts
//   --mine <userId>   internal: run one mine for a user and print its summary as JSON
//                     (MINER_INCREMENTAL is read from the spawned env at import time,
//                     which is why each mine is its own child process)
//   [--captures N]    cap the cloned corpus to N captures (default: all of the real
//                     user's captures)
//   [--source <email>] clone from this user's captures (default natekeola@icloud.com)

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
// reuse the miner's own fuzzy matcher so "label drift of the same entity" (cosmetic)
// is distinguished from a genuinely missing/extra entity. Same jaccard the resolver uses.
import { tokens, jaccard } from '../packages/miner-core/src/resolution'

// Two labels are the same entity drifted (cosmetic) at/above this token-Jaccard.
const DRIFT_THRESHOLD = 0.5

// --- env ---
function loadEnvLocal() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch {
    /* rely on real env */
  }
}
loadEnvLocal()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
}

const NODE_TABLES = [
  'canonical_people',
  'canonical_places_orgs',
  'canonical_projects',
  'canonical_events',
  'canonical_facts',
  'canonical_commitments',
] as const
const EDGE_TABLE = 'canonical_relationships'
const ALL_CANON = [...NODE_TABLES, EDGE_TABLE, 'insights'] as const
// raw tables that map to a canonical node/edge table (collection_mentions has no
// canonical target by design, so it is excluded from coverage).
const RAW_MAPPED = [
  'raw_people',
  'raw_places_orgs',
  'raw_projects',
  'raw_events',
  'raw_facts',
  'raw_relationships',
  'raw_commitments',
] as const

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : '')

// ---------------------------------------------------------------------------
// --mine child: run a single mine and print its summary. INCREMENTAL is read from
// the spawned env at import time of the miner, so this MUST be its own process.
// ---------------------------------------------------------------------------
async function runMineChild(userId: string): Promise<void> {
  const { mine } = await import('../packages/miner-core/src/run')
  const summary = await mine(userId, Date.now())
  console.log('HARNESS_SUMMARY ' + JSON.stringify(summary))
}

// ---------------------------------------------------------------------------
// orchestrator helpers
// ---------------------------------------------------------------------------

async function lookupUserId(db: SupabaseClient, email: string): Promise<string> {
  // page through admin.listUsers (dev has few users)
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers: ${error.message}`)
    const u = data.users.find((x) => (x.email ?? '').toLowerCase() === email.toLowerCase())
    if (u) return u.id
    if (data.users.length < 200) break
  }
  throw new Error(`no user with email ${email}`)
}

async function createThrowawayUser(db: SupabaseClient, tag: string): Promise<string> {
  const email = `inc-harness-${Date.now()}-${tag}@test.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`)
  return data.user.id
}

type SrcCapture = { mode: string; modality: string; body: string | null; created_at: string }

async function readSourceCaptures(db: SupabaseClient, sourceUserId: string, limit: number | null): Promise<SrcCapture[]> {
  const { data, error } = await db
    .from('captures')
    .select('mode, modality, body, created_at')
    .eq('user_id', sourceUserId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`read source captures: ${error.message}`)
  const all = (data ?? []) as SrcCapture[]
  return limit ? all.slice(0, limit) : all
}

// Insert cloned capture rows under the test user. Append-only INSERT; target_kind /
// target_id are dropped (they reference the source user's canonical graph). created_at
// is preserved so the mine's capture order matches the source.
async function cloneCaptures(db: SupabaseClient, userId: string, caps: SrcCapture[]): Promise<number> {
  if (caps.length === 0) return 0
  const rows = caps.map((c) => ({
    user_id: userId,
    mode: c.mode,
    modality: c.modality,
    body: c.body,
    created_at: c.created_at,
  }))
  const { error } = await db.from('captures').insert(rows)
  if (error) throw new Error(`clone captures: ${error.message}`)
  return rows.length
}

// Bust the derive-memo so a second full mine re-derives (no re-extraction). An UPDATE
// of the input_hash, never a delete (miner_state is mutable operational state).
async function bustDeriveMemo(db: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await db
    .from('miner_state')
    .select('id, scope')
    .eq('user_id', userId)
    .like('scope', 'derive:%')
  if (error) throw new Error(`read derive memo: ${error.message}`)
  const ids = (data ?? []).map((r) => (r as { id: string }).id)
  let busted = 0
  for (const id of ids) {
    const { error: uErr } = await db
      .from('miner_state')
      .update({ input_hash: 'HARNESS_BUST', updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('id', id)
    if (uErr) throw new Error(`bust memo: ${uErr.message}`)
    busted++
  }
  return busted
}

type MineMetrics = { wallMs: number; tokensIn: number; tokensOut: number; llmCalls: number; passes: Record<string, unknown>[] }

// Spawn a child to run one mine with the given MINER_INCREMENTAL, measure wall-clock,
// and parse the summary it prints (tokens + call counts).
function mineOnce(userId: string, incremental: boolean, label: string): MineMetrics {
  const self = fileURLToPath(import.meta.url)
  console.log(`\n>>> MINE ${label}: user=${userId.slice(0, 8)} MINER_INCREMENTAL=${incremental ? '1' : '0'}`)
  const t0 = Date.now()
  const res = spawnSync('npx', ['tsx', self, '--mine', userId], {
    encoding: 'utf8',
    env: { ...process.env, MEMO_USER_ID: userId, MINER_INCREMENTAL: incremental ? '1' : '0' },
    maxBuffer: 64 * 1024 * 1024,
  })
  const wallMs = Date.now() - t0
  if (res.status !== 0) {
    console.error(res.stdout)
    console.error(res.stderr)
    throw new Error(`mine ${label} failed (exit ${res.status})`)
  }
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('HARNESS_SUMMARY '))
  if (!line) {
    console.error(res.stdout)
    throw new Error(`mine ${label}: no summary in output`)
  }
  const summary = JSON.parse(line.slice('HARNESS_SUMMARY '.length)) as {
    extractUsage: { input_tokens: number; output_tokens: number }
    extracted: number
    passes: Array<{ table: string; batches: number; skipped: boolean; usage: { input_tokens: number; output_tokens: number }; rows: number; inserted: number; updated: number; unchanged: number }>
  }
  let tokensIn = summary.extractUsage.input_tokens
  let tokensOut = summary.extractUsage.output_tokens
  let llmCalls = summary.extracted // one extraction call per newly-extracted capture
  for (const p of summary.passes) {
    tokensIn += p.usage.input_tokens
    tokensOut += p.usage.output_tokens
    llmCalls += p.batches
  }
  console.log(`    ${label} done in ${(wallMs / 1000).toFixed(1)}s; llmCalls=${llmCalls} tokensIn=${tokensIn} tokensOut=${tokensOut}`)
  return { wallMs, tokensIn, tokensOut, llmCalls, passes: summary.passes as unknown as Record<string, unknown>[] }
}

// ---- snapshot + structural diff ----

type Snapshot = {
  labelsByTable: Record<string, Set<string>>
  edgeTriples: Set<string>
  perTableCount: Record<string, number>
  coverage: { total: number; covered: number; pct: number }
  citedClaimIds: Set<string>
}

async function snapshot(db: SupabaseClient, userId: string): Promise<Snapshot> {
  const labelsByTable: Record<string, Set<string>> = {}
  const perTableCount: Record<string, number> = {}
  const idToLabel = new Map<string, string>()
  const citedClaimIds = new Set<string>()
  const rowsByTable: Record<string, Array<{ id: string; label: string | null; data: Record<string, unknown>; source_claim_ids: string[] }>> = {}

  for (const table of ALL_CANON) {
    const { data, error } = await db
      .from(table)
      .select('id, label, data, source_claim_ids')
      .eq('user_id', userId)
      .is('valid_to', null)
    if (error) throw new Error(`snapshot ${table}: ${error.message}`)
    const rows = (data ?? []).map((r) => {
      const row = r as { id: string; label: string | null; data: Record<string, unknown> | null; source_claim_ids: string[] | null }
      return { id: String(row.id), label: row.label, data: (row.data ?? {}) as Record<string, unknown>, source_claim_ids: row.source_claim_ids ?? [] }
    })
    rowsByTable[table] = rows
    perTableCount[table] = rows.length
    for (const row of rows) {
      idToLabel.set(row.id, norm(row.label))
      for (const c of row.source_claim_ids) citedClaimIds.add(c)
    }
    // insights are keyed on their statement; nodes on their label
    labelsByTable[table] = new Set(
      rows.map((r) => (table === 'insights' ? norm((r.data.statement as string) ?? r.label) : norm(r.label))).filter(Boolean)
    )
  }

  // edges as resolved-label triples (comparable across users)
  const edgeTriples = new Set<string>()
  for (const r of rowsByTable[EDGE_TABLE] ?? []) {
    const s = idToLabel.get(String(r.data.source_id)) ?? norm(String(r.data.source_id))
    const t = idToLabel.get(String(r.data.target_id)) ?? norm(String(r.data.target_id))
    const rel = norm(String(r.data.relation))
    if (s && t && rel) edgeTriples.add(`${s}|${rel}|${t}`)
  }

  // coverage: of all mapped raw claim ids, how many are cited by some current row
  const rawIds = new Set<string>()
  for (const table of RAW_MAPPED) {
    const { data, error } = await db.from(table).select('id').eq('user_id', userId)
    if (error) throw new Error(`snapshot raw ${table}: ${error.message}`)
    for (const r of data ?? []) rawIds.add(String((r as { id: string }).id))
  }
  let covered = 0
  for (const id of rawIds) if (citedClaimIds.has(id)) covered++
  const pct = rawIds.size === 0 ? 1 : covered / rawIds.size

  return { labelsByTable, edgeTriples, perTableCount, coverage: { total: rawIds.size, covered, pct }, citedClaimIds }
}

// Diff two label sets, then greedily pair "onlyA" with "onlyB" entries that are the
// SAME entity drifted (token-Jaccard >= DRIFT_THRESHOLD). raw counts everything as a
// difference; genuine counts only the entries left UNPAIRED (a real missing/extra
// entity, not a reworded label). The genuine number is the structural-equivalence
// signal; raw includes cosmetic LLM wording drift.
function setDiff(a: Set<string>, b: Set<string>) {
  const onlyA = [...a].filter((x) => !b.has(x))
  const onlyB = [...b].filter((x) => !a.has(x))
  const common = [...a].filter((x) => b.has(x))
  // greedy fuzzy pairing
  const usedB = new Set<number>()
  let driftPairs = 0
  const genuineA: string[] = []
  for (const la of onlyA) {
    const ta = tokens(la)
    let bestJ = 0
    let bestI = -1
    for (let i = 0; i < onlyB.length; i++) {
      if (usedB.has(i)) continue
      const j = jaccard(ta, tokens(onlyB[i]))
      if (j > bestJ) {
        bestJ = j
        bestI = i
      }
    }
    if (bestI >= 0 && bestJ >= DRIFT_THRESHOLD) {
      usedB.add(bestI)
      driftPairs++
    } else {
      genuineA.push(la)
    }
  }
  const genuineB = onlyB.filter((_, i) => !usedB.has(i))
  return {
    onlyA,
    onlyB,
    common,
    rawSym: onlyA.length + onlyB.length,
    genuineA,
    genuineB,
    genuineSym: genuineA.length + genuineB.length,
    driftPairs,
  }
}

type DiffReport = {
  table: string
  aCount: number
  bCount: number
  common: number
  rawSym: number
  genuineSym: number
  driftPairs: number
  genuineALabels: string[]
  genuineBLabels: string[]
}

function reportOf(table: string, a: Set<string>, b: Set<string>): DiffReport {
  const d = setDiff(a, b)
  return {
    table,
    aCount: a.size,
    bCount: b.size,
    common: d.common.length,
    rawSym: d.rawSym,
    genuineSym: d.genuineSym,
    driftPairs: d.driftPairs,
    genuineALabels: d.genuineA.slice(0, 10),
    genuineBLabels: d.genuineB.slice(0, 10),
  }
}

function diffSnapshots(a: Snapshot, b: Snapshot): { tables: DiffReport[]; edges: DiffReport } {
  const tables = ALL_CANON.map((t) => reportOf(t, a.labelsByTable[t] ?? new Set(), b.labelsByTable[t] ?? new Set()))
  const edges = reportOf(EDGE_TABLE, a.edgeTriples, b.edgeTriples)
  return { tables, edges }
}

function printDiff(title: string, d: { tables: DiffReport[]; edges: DiffReport }) {
  console.log(`\n--- ${title} ---`)
  console.log(`    (by normalized label; raw = all label differences, genuine = after pairing off cosmetic label drift)`)
  for (const r of [...d.tables, d.edges]) {
    console.log(
      `  ${r.table.padEnd(24)} A=${String(r.aCount).padStart(3)} B=${String(r.bCount).padStart(3)} common=${String(r.common).padStart(3)} drift=${String(r.driftPairs).padStart(3)} rawSym=${String(r.rawSym).padStart(3)} GENUINE=${String(r.genuineSym).padStart(3)}`
    )
    if (r.genuineALabels.length) console.log(`      genuine onlyA: ${r.genuineALabels.join(', ')}`)
    if (r.genuineBLabels.length) console.log(`      genuine onlyB: ${r.genuineBLabels.join(', ')}`)
  }
}

const sumRaw = (d: { tables: DiffReport[]; edges: DiffReport }) => [...d.tables, d.edges].reduce((s, r) => s + r.rawSym, 0)
// genuine divergence EXCLUDING insights (incremental does not refresh global insights
// by design, so they are expected to differ and must not count against equivalence).
const sumGenuineCore = (d: { tables: DiffReport[]; edges: DiffReport }) =>
  [...d.tables, d.edges].filter((r) => r.table !== 'insights').reduce((s, r) => s + r.genuineSym, 0)

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function orchestrate(): Promise<void> {
  const argv = process.argv.slice(2)
  const capArg = argv.indexOf('--captures')
  const capLimit = capArg >= 0 ? Number(argv[capArg + 1]) : null
  const srcArg = argv.indexOf('--source')
  const sourceEmail = srcArg >= 0 ? argv[srcArg + 1] : 'natekeola@icloud.com'

  const db = admin()
  console.log('== Incremental equivalence + perf harness ==')
  console.log(`source corpus: ${sourceEmail}${capLimit ? ` (capped to ${capLimit})` : ' (all)'}`)

  const sourceId = await lookupUserId(db, sourceEmail)
  const caps = await readSourceCaptures(db, sourceId, capLimit)
  console.log(`cloning ${caps.length} captures`)
  if (caps.length < 4) throw new Error('need at least 4 captures for a meaningful split')

  const split = Math.max(1, Math.round(caps.length * 0.7))
  const firstBatch = caps.slice(0, split)
  const secondBatch = caps.slice(split)
  console.log(`split: baseline ${firstBatch.length} + fold ${secondBatch.length}`)

  // --- userD: the FULL path, and the noise floor (two independent full derivations) ---
  const userD = await createThrowawayUser(db, 'full')
  await cloneCaptures(db, userD, caps)
  const dFull1 = mineOnce(userD, false, 'D full #1 (whole corpus)')
  const snapD1 = await snapshot(db, userD)
  const busted = await bustDeriveMemo(db, userD)
  console.log(`    busted ${busted} derive-memo scopes (re-derive, no re-extraction)`)
  const dFull2 = mineOnce(userD, false, 'D full #2 (re-derive, noise floor)')
  const snapD2 = await snapshot(db, userD)

  // --- userC: the production-shaped incremental path ---
  const userC = await createThrowawayUser(db, 'inc')
  await cloneCaptures(db, userC, firstBatch)
  const cBaseline = mineOnce(userC, true, `C baseline (${firstBatch.length}, full branch)`)
  await cloneCaptures(db, userC, secondBatch)
  const cFold = mineOnce(userC, true, `C incremental fold (+${secondBatch.length})`)
  const snapC = await snapshot(db, userC)

  // persist snapshots so the diff can be re-analyzed without re-mining
  const snapFile = `/tmp/harness-snapshots-${Date.now()}.json`
  try {
    const ser = (s: Snapshot) => ({
      labelsByTable: Object.fromEntries(Object.entries(s.labelsByTable).map(([k, v]) => [k, [...v]])),
      edgeTriples: [...s.edgeTriples],
      perTableCount: s.perTableCount,
      coverage: s.coverage,
    })
    writeFileSync(snapFile, JSON.stringify({ D1: ser(snapD1), D2: ser(snapD2), C: ser(snapC), userD, userC }, null, 2))
    console.log(`\n(snapshots persisted to ${snapFile})`)
  } catch {
    /* best effort */
  }

  // --- diffs ---
  const noiseFloor = diffSnapshots(snapD1, snapD2)
  const equivalence = diffSnapshots(snapC, snapD2)
  printDiff('NOISE FLOOR: D full#1 vs D full#2 (LLM nondeterminism yardstick)', noiseFloor)
  printDiff('EQUIVALENCE: C incremental vs D full (the test)', equivalence)

  const floorRaw = sumRaw(noiseFloor)
  const equivRaw = sumRaw(equivalence)
  const floorCore = sumGenuineCore(noiseFloor) // genuine, excluding insights
  const equivCore = sumGenuineCore(equivalence)
  const insightsExpected = equivalence.tables.find((t) => t.table === 'insights')?.rawSym ?? 0

  console.log('\n== COVERAGE (every mapped raw claim cited by a current row) ==')
  console.log(`  D full#1: ${snapD1.coverage.covered}/${snapD1.coverage.total} = ${(snapD1.coverage.pct * 100).toFixed(1)}%`)
  console.log(`  D full#2: ${snapD2.coverage.covered}/${snapD2.coverage.total} = ${(snapD2.coverage.pct * 100).toFixed(1)}%`)
  console.log(`  C incr  : ${snapC.coverage.covered}/${snapC.coverage.total} = ${(snapC.coverage.pct * 100).toFixed(1)}%`)

  console.log('\n== PERF + COST ==')
  const s = (m: MineMetrics) => `${(m.wallMs / 1000).toFixed(1)}s, ${m.llmCalls} calls, ${m.tokensIn}+${m.tokensOut} tok`
  console.log(`  full recompute (whole corpus)  : ${s(dFull1)}`)
  console.log(`  full re-derive (noise floor)   : ${s(dFull2)}`)
  console.log(`  incremental baseline (${firstBatch.length} caps): ${s(cBaseline)}`)
  console.log(`  incremental FOLD (+${secondBatch.length} caps)    : ${s(cFold)}`)
  const speedup = dFull1.wallMs / Math.max(1, cFold.wallMs)
  const callRatio = cFold.llmCalls / Math.max(1, dFull1.llmCalls)
  console.log(`  fold vs full: ${speedup.toFixed(1)}x faster, ${(callRatio * 100).toFixed(0)}% of the API calls`)

  console.log('\n== VERDICT ==')
  console.log(`  raw label/edge symDiff (incl cosmetic drift)  : floor(D1vD2)=${floorRaw}  incremental(CvD)=${equivRaw}`)
  console.log(`  GENUINE divergence (drift-paired, excl insights): floor=${floorCore}  incremental=${equivCore}`)
  console.log(`  insights divergence (expected; incremental does NOT refresh global insights): ${insightsExpected}`)
  const coverageOk = snapC.coverage.pct >= Math.min(snapD1.coverage.pct, snapD2.coverage.pct) - 0.03
  const withinFloor = equivCore <= floorCore * 2 + 6 // genuine entity/edge divergence within the noise envelope
  const foldFast = cFold.wallMs < 300_000 && cFold.wallMs < dFull1.wallMs
  const pass = coverageOk && withinFloor && foldFast
  console.log(`  coverage not regressed         : ${coverageOk}  (C ${(snapC.coverage.pct * 100).toFixed(1)}% vs full ${(snapD2.coverage.pct * 100).toFixed(1)}%)`)
  console.log(`  genuine divergence within floor: ${withinFloor}  (incremental ${equivCore} vs floor*2+6 = ${floorCore * 2 + 6})`)
  console.log(`  fold under 300s & faster       : ${foldFast}  (${(cFold.wallMs / 1000).toFixed(1)}s)`)
  console.log(`\n  RECOMMENDATION: ${pass ? 'PASS' : 'NEEDS REVIEW'} - ${pass ? 'incremental preserves the graph (coverage + genuine structure) and is far faster; safe to flip MINER_INCREMENTAL=1 after review. Cosmetic label drift and the insights gap are trued up by the periodic full rebuild; pair with MINER_STABLE_IDENTITY to minimize drift.' : 'genuine entity/edge divergence exceeds the noise floor; inspect the genuine onlyA/onlyB lists above before flipping.'}`)
  console.log(`\n  throwaway users (residue, no deletes): full=${userD} inc=${userC}`)
}

// Quick re-analysis of two EXISTING users (full=A, incremental=B) without mining, so
// the drift-aware diff can be validated / re-read against settled graphs.
async function diffMode(userFull: string, userInc: string): Promise<void> {
  const db = admin()
  console.log(`== --diff: full=${userFull.slice(0, 8)} vs incremental=${userInc.slice(0, 8)} ==`)
  const snapD = await snapshot(db, userFull)
  const snapC = await snapshot(db, userInc)
  const equivalence = diffSnapshots(snapC, snapD)
  printDiff('EQUIVALENCE: incremental vs full', equivalence)
  console.log('\n== COVERAGE ==')
  console.log(`  full: ${(snapD.coverage.pct * 100).toFixed(1)}%   incremental: ${(snapC.coverage.pct * 100).toFixed(1)}%`)
  console.log(`  raw symDiff=${sumRaw(equivalence)}  GENUINE (drift-paired, excl insights)=${sumGenuineCore(equivalence)}  insights(expected)=${equivalence.tables.find((t) => t.table === 'insights')?.rawSym ?? 0}`)
}

if (process.argv.includes('--mine')) {
  const userId = process.argv[process.argv.indexOf('--mine') + 1]
  runMineChild(userId).catch((e) => {
    console.error('[mine child] failed:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
} else if (process.argv.includes('--diff')) {
  const i = process.argv.indexOf('--diff')
  diffMode(process.argv[i + 1], process.argv[i + 2]).catch((e) => {
    console.error('[diff] failed:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
} else {
  orchestrate().catch((e) => {
    console.error('[harness] failed:', e instanceof Error ? e.stack || e.message : e)
    process.exit(1)
  })
}
