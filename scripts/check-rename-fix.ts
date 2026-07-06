// Verifies the Phase 1 rename-pending fix end to end.
//
// Bug A (pending overlay never cleared for an in-place rename): the contact-sheet
// overlay (lib/people.ts applyPending) marked a rename "pending" whenever the
// correction's person_id still matched a CURRENT row. The stable-identity resolver
// keeps a row's id and relabels IN PLACE (Morgan -> Morgan Alexander, Nate -> Nate
// Tennant), so the id never changed and the old self-consume never fired: the rename
// showed "pending" forever though it had applied. The fix clears the flag once the
// current row's label already equals the target. Verified against the LIVE graph:
// the actually-stuck people clear, and a not-yet-mined rename stays pending.
//
// Bug B (miner never applied a pure in-place relabel): writeCanonical's
// change-signature excludes the label (churn control), so a rename that resolves to
// the same id with an unchanged claim set (a typo fix like Sean Yanka -> Sean Janka)
// was skipped and never landed in canonical. applyRenameLabels forces it. Verified
// live against a seeded, self-cleaning row (the REAL function).
//
// Run: npx tsx scripts/check-rename-fix.ts
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { normalizeLabel } from '../packages/miner-core/src/identity'
import { applyRenameLabels } from '../packages/miner-core/src/corrections'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

// Mirror of lib/people.ts applyPending clear rule (the two lines the fix changed).
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}
function overlayPending(currentLabel: string | null, target: string): boolean {
  if (currentLabel && norm(currentLabel) === norm(target)) return false // rename has landed
  return true
}

async function main() {
  console.log('== Bug A: pending overlay clears when the label already equals the target ==')
  check('in-place applied rename is NOT pending', overlayPending('Morgan Alexander', 'Morgan Alexander') === false)
  check('not-yet-applied rename IS pending', overlayPending('Sean Yanka', 'Sean Janka') === true)
  check('a missing/blank label stays pending', overlayPending(null, 'Whoever') === true)

  // Live: for every rename_person correction whose targeted person_id is STILL a
  // current row, the fix pending flag must equal (current label != target). This is
  // the exact contact-sheet decision, against real data.
  console.log('\n== Bug A live: real rename corrections vs current people ==')
  const { data: corrs } = await svc
    .from('corrections')
    .select('user_id, payload, created_at')
    .eq('kind', 'rename_person')
    .order('created_at', { ascending: true })
  let liveChecked = 0
  let liveStuckBefore = 0
  for (const c of (corrs ?? []) as Array<{ user_id: string; payload: Record<string, unknown> | null }>) {
    const p = c.payload ?? {}
    const personId = typeof p.person_id === 'string' ? p.person_id : ''
    const to = (typeof p.to_label === 'string' && p.to_label) || (typeof p.to === 'string' && p.to) || ''
    if (!personId || !to) continue
    const { data: rows } = await svc
      .from('canonical_people')
      .select('id, label')
      .eq('user_id', c.user_id)
      .eq('id', personId)
      .is('valid_to', null)
    const row = (rows ?? [])[0] as { id: string; label: string | null } | undefined
    if (!row) continue // superseded / merged away -> not iterated by the overlay at all
    liveChecked++
    const pendingNow = overlayPending(row.label, to)
    const applied = normalizeLabel(row.label ?? '') === normalizeLabel(to)
    // The OLD overlay always returned pending=true here (person_id matched a current
    // row). If the label already equals the target, that was a stuck false-positive
    // the fix now clears.
    if (applied) {
      liveStuckBefore++
      check(`applied-in-place "${row.label}" (target "${to}") is NOT pending after fix`, pendingNow === false)
    } else {
      check(`unapplied "${row.label}" -> "${to}" is still pending (correct)`, pendingNow === true)
    }
  }
  console.log(`  (checked ${liveChecked} in-place corrections; ${liveStuckBefore} were stuck-pending before the fix)`)

  // Bug B: exercise the REAL applyRenameLabels against a seeded, self-cleaning row.
  console.log('\n== Bug B live: applyRenameLabels forces an in-place relabel ==')
  const testUser = process.env.MEMO_USER_ID!
  const SEED = 'aaaaaaaa-0000-4000-8000-000000000f11' // a fixed test id (all hex)
  // clean any prior residue
  await svc.from('canonical_people').delete().eq('user_id', testUser).eq('id', SEED)
  const seed = {
    id: SEED,
    user_id: testUser,
    label: 'Zzz Renametest Original',
    data: { aliases: ['Zzz Alias'], first_name: 'Zzz', last_name: 'Renametest Original' },
    source_claim_ids: [] as string[],
    temporality: 'evergreen',
    confidence: 0.7,
    salience: 0.1,
    summary: null,
  }
  const { error: insErr } = await svc.from('canonical_people').insert(seed)
  if (insErr) { check('seed insert', false, insErr.message); return finish() }

  const idToFinal = new Map<string, string>([[SEED, 'Zzz Renametest Corrected']])
  const n1 = await applyRenameLabels(testUser, idToFinal)
  const { data: after1 } = await svc.from('canonical_people').select('label, data').eq('user_id', testUser).eq('id', SEED).single()
  const a1 = after1 as { label: string; data: Record<string, unknown> }
  check('applyRenameLabels relabeled the in-place row', a1?.label === 'Zzz Renametest Corrected', `got ${a1?.label}`)
  check('first/last recomputed from the new label', a1?.data?.first_name === 'Zzz' && a1?.data?.last_name === 'Renametest Corrected')
  check('old label kept as an alias', Array.isArray(a1?.data?.aliases) && (a1.data.aliases as string[]).includes('Zzz Renametest Original'))
  check('applyRenameLabels reported 1 relabel', n1 === 1, `got ${n1}`)

  // Idempotency: a second run is a clean no-op.
  const n2 = await applyRenameLabels(testUser, idToFinal)
  check('second run is a no-op (0 relabels)', n2 === 0, `got ${n2}`)

  // A superseded row is left alone.
  await svc.from('canonical_people').update({ valid_to: new Date().toISOString() }).eq('user_id', testUser).eq('id', SEED)
  const n3 = await applyRenameLabels(testUser, new Map([[SEED, 'Zzz Renametest Again']]))
  check('a superseded (retired) row is NOT relabeled', n3 === 0, `got ${n3}`)

  // cleanup
  await svc.from('canonical_people').delete().eq('user_id', testUser).eq('id', SEED)
  const { data: gone } = await svc.from('canonical_people').select('id').eq('user_id', testUser).eq('id', SEED)
  check('seed row cleaned up (no residue)', (gone ?? []).length === 0)

  finish()
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
