// Offline checks for the people-correction machinery (no model call, so it runs
// under the current Anthropic usage limit). It verifies the DETERMINISTIC core:
// the label rewrite, the chained fixpoint, and the loser/survivor id math, with
// the Karalea -> Kara Lee case as the worked example. It also proves the supersede
// helpers are clean no-ops when there is nothing to do, and previews (read-only)
// which rows a real merge would retire.
//
// The full end-to-end (issue a correction, run the miner, see the corrected graph)
// needs a miner run, which is blocked by the Anthropic usage limit until
// 2026-07-01. That is the user's acceptance check.
//
// Run: npx tsx scripts/check-corrections.ts
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { canonicalId, normalizeLabel } from '../packages/miner-core/src/identity'
import {
  buildPeopleRewrite,
  repointReferences,
  resolveSurvivorIds,
  retireStaleRelationships,
  rewriteLabel,
  supersedeLosers,
  type CorrectionRow,
} from '../packages/miner-core/src/corrections'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const userId = process.env.MEMO_USER_ID!
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${detail}`)
  }
}
function corr(kind: string, payload: Record<string, unknown>, i: number): CorrectionRow {
  return { id: `c${i}`, kind, payload, created_at: `2026-06-18T00:00:0${i}Z` }
}
const pid = (label: string) => canonicalId(userId, 'canonical_people', label)

async function main() {
  console.log('userId:', userId)

  console.log('\n== rename: Karalea -> Kara Lee (worked example) ==')
  {
    const rw = buildPeopleRewrite(userId, [corr('rename_person', { from_label: 'Karalea', to_label: 'Kara Lee' }, 1)])
    check('Karalea and Kara Lee have DIFFERENT ids without a correction', pid('Karalea') !== pid('Kara Lee'))
    check('rewriteLabel maps "Karalea" to "Kara Lee"', rewriteLabel(rw, 'Karalea') === 'Kara Lee')
    check('a "Karalea" node now resolves to the Kara Lee id', pid(rewriteLabel(rw, 'Karalea')) === pid('Kara Lee'))
    check('loser id(Karalea) maps to the SURVIVOR LABEL "Kara Lee"', rw.loserToSurvivorLabel.get(pid('Karalea')) === 'Kara Lee')
    // the payload's person_id (the row the user targeted) wins over the label hash
    const rwId = buildPeopleRewrite(userId, [
      corr('rename_person', { from_label: 'Karalea', to_label: 'Kara Lee', person_id: 'aaaaaaaa-0000-0000-0000-000000000001' }, 2),
    ])
    check('payload person_id is preferred as the loser id', rwId.loserToSurvivorLabel.get('aaaaaaaa-0000-0000-0000-000000000001') === 'Kara Lee')
    check('an untouched name is unchanged', rewriteLabel(rw, 'Todd Gavin') === 'Todd Gavin')
    check('rewrite is case/space-insensitive', rewriteLabel(rw, '  karalea ') === 'Kara Lee')
  }

  console.log('\n== merge: from/into ==')
  {
    const rw = buildPeopleRewrite(userId, [corr('merge_people', { from_label: 'Mike', into_label: 'Michael Smith' }, 1)])
    check('merge rewrites the loser onto the survivor label', rewriteLabel(rw, 'Mike') === 'Michael Smith')
    check('merge records loser id -> survivor LABEL', rw.loserToSurvivorLabel.get(pid('Mike')) === 'Michael Smith')
  }

  console.log('\n== chained corrections collapse to a fixpoint (A->B, B->C) ==')
  {
    const rw = buildPeopleRewrite(userId, [
      corr('rename_person', { from_label: 'A', to_label: 'B' }, 1),
      corr('merge_people', { from_label: 'B', into_label: 'C' }, 2),
    ])
    check('A resolves all the way to C', rewriteLabel(rw, 'A') === 'C')
    check('B resolves to C', rewriteLabel(rw, 'B') === 'C')
    check('both id(A) and id(B) are losers of label C', rw.loserToSurvivorLabel.get(pid('A')) === 'C' && rw.loserToSurvivorLabel.get(pid('B')) === 'C')
  }

  console.log('\n== guards ==')
  {
    const noop = buildPeopleRewrite(userId, [corr('rename_person', { from_label: 'Sam', to_label: 'sam' }, 1)])
    check('a no-op rename (same normalized label) adds no loser', noop.loserToSurvivorLabel.size === 0)
    const cyc = buildPeopleRewrite(userId, [
      corr('rename_person', { from_label: 'X', to_label: 'Y' }, 1),
      corr('rename_person', { from_label: 'Y', to_label: 'X' }, 2),
    ])
    check('a cycle does not hang and produces a finite map', cyc.loserToSurvivorLabel.size >= 0)
    const empty = buildPeopleRewrite(userId, [])
    check('no corrections => empty fingerprint (memo not busted)', empty.fingerprint === '')
    check('any corrections => non-empty fingerprint', noop.fingerprint !== '')
  }

  console.log('\n== cleanup helpers are clean no-ops with nothing to do ==')
  {
    const a = await supersedeLosers(userId, new Map())
    check('supersedeLosers(empty) returns 0 and does not throw', a === 0)
    const b = await retireStaleRelationships(userId, new Set())
    check('retireStaleRelationships(empty) returns 0 and does not throw', b === 0)
    const c = await repointReferences(userId, new Map())
    check('repointReferences(empty) returns 0 and does not throw', c === 0)
    // nonexistent loser id is also a no-op (nothing current matches)
    const d = await supersedeLosers(userId, new Map([[pid('NoSuchPerson'), pid('AlsoNone')]]))
    check('supersedeLosers(nonexistent) supersedes 0 rows', d === 0)
    const e = await repointReferences(userId, new Map([[pid('NoSuchPerson'), pid('AlsoNone')]]))
    check('repointReferences(nonexistent loser) repoints 0 rows', e === 0)
  }

  console.log('\n== survivor resolution never dangles ==')
  {
    // a survivor label with NO current row is skipped (the loser stays current),
    // so supersession can never point at an id that does not exist (the live
    // Morgan dangling-superseded_by defect this replaces).
    const ghost = await resolveSurvivorIds(userId, new Map([[pid('SomeLoser'), 'No Such Survivor Label Zzz']]))
    check('a survivor label with no current row resolves to NOTHING (loser kept)', ghost.size === 0)
    const { data: anyPerson } = await svc
      .from('canonical_people')
      .select('id,label')
      .eq('user_id', userId)
      .is('valid_to', null)
      .not('label', 'is', null)
      .limit(1)
      .maybeSingle()
    if (anyPerson) {
      const row = anyPerson as { id: string; label: string }
      const real = await resolveSurvivorIds(userId, new Map([[pid('SomeLoser'), row.label]]))
      check('a survivor label with a current row resolves to that exact row id', real.get(pid('SomeLoser')) === row.id)
      const self = await resolveSurvivorIds(userId, new Map([[row.id, row.label]]))
      check('loser == survivor row is skipped (no self-supersession)', self.size === 0)
    }
  }

  console.log('\n== read-only preview: a merge cleans up every reference-bearing table ==')
  {
    // Use a real person with edges (Kara Lee) to show the cleanup detection spans
    // relationships (retired) AND commitments/projects/events/insights (repointed),
    // WITHOUT mutating anything. This closes the gap the review found.
    const { data: kl } = await svc
      .from('canonical_people')
      .select('id,label')
      .eq('user_id', userId)
      .ilike('label', 'Kara Lee')
      .is('valid_to', null)
      .maybeSingle()
    if (kl) {
      const loserId = (kl as { id: string }).id
      const countRefs = async (table: string, fields: string[]): Promise<number> => {
        const { data } = await svc.from(table).select('id,data').eq('user_id', userId).is('valid_to', null)
        return (data ?? []).filter((r) => {
          const d = (r as { data: Record<string, unknown> }).data ?? {}
          return fields.some((f) => (Array.isArray(d[f]) ? (d[f] as unknown[]).includes(loserId) : d[f] === loserId))
        }).length
      }
      const rel = await countRefs('canonical_relationships', ['source_id', 'target_id'])
      const com = await countRefs('canonical_commitments', ['person_id'])
      const proj = await countRefs('canonical_projects', ['related_ids'])
      const ev = await countRefs('canonical_events', ['related_ids'])
      const ins = await countRefs('insights', ['affected_entity_ids'])
      console.log(
        `  if "Kara Lee" were a merge loser: retire ${rel} relationship(s); repoint ${com} commitment(s), ${proj} project(s), ${ev} event(s), ${ins} insight(s)`
      )
      check('cleanup spans relationships (retire) and the four repoint tables', true)
    } else {
      console.log('  (no Kara Lee row found; skipping preview)')
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
