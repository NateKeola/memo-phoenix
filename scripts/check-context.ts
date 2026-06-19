// Offline checks for "add context from anywhere" + the identity fixes. No model
// call and no send, so it runs under the current usage limit. It proves the
// first+last identity is id-PRESERVING, the pending-rename display overlay shows
// "Karalea" without a mine, the capture-with-target shape is honored, and the
// sending layer is still gone.
//
// Run: npx tsx scripts/check-context.ts
import { existsSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { canonicalId, canonicalPersonId, personKey, splitName } from '../packages/miner-core/src/identity'
import { parseTarget } from '../lib/capture-target'
import { firstLast, personDisplay } from '../lib/names'
import { listPeople, pendingRenames } from '../lib/people'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const userId = process.env.MEMO_USER_ID!
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})

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

async function main() {
  console.log('== Task 1a: first+last identity is id-PRESERVING (no churn) ==')
  for (const label of ['Kara Lee', 'Kristen', 'Todd Gavin', 'Morgan Alexander Peterson', 'Dolores Tennant']) {
    const { first, last } = splitName(label)
    const pid = canonicalPersonId(userId, first, last)
    const old = canonicalId(userId, 'canonical_people', label)
    check(`canonicalPersonId == old label id for "${label}"`, pid === old, `${pid} vs ${old}`)
  }
  check('single-token name splits to first only', splitName('Karalea').first === 'Karalea' && splitName('Karalea').last === '')
  check('multi-token last name is the rest', splitName('Morgan Alexander Peterson').last === 'Alexander Peterson')
  check('a rename to "Karalea" maps to a DIFFERENT id than "Kara Lee"', canonicalPersonId(userId, 'Karalea', '') !== canonicalPersonId(userId, 'Kara', 'Lee'))
  check('personKey rejoins first+last (reconstructs the label)', personKey('Kara', 'Lee') === 'kara lee' && personKey('Karalea', '') === 'karalea')

  console.log('\n== first/last display ==')
  check('firstLast prefers persisted data', firstLast('ignored label', { first_name: 'Ada', last_name: 'Lovelace' }).first === 'Ada')
  check('firstLast falls back to splitting the label', firstLast('Grace Hopper', null).last === 'Hopper')
  check('personDisplay joins, dropping an empty last', personDisplay('Karalea', '') === 'Karalea')

  console.log('\n== Task 1b: pending-rename display overlay (Karalea), no mine, no canonical edit ==')
  const renames = await pendingRenames({ supabase: svc, userId })
  console.log('  pending rename map (keyed on person id):', JSON.stringify([...renames.entries()]))
  // the overlay is keyed on the specific person id the correction targets
  const { data: karaRow } = await svc
    .from('canonical_people')
    .select('id')
    .eq('user_id', userId)
    .ilike('label', 'Kara Lee')
    .is('valid_to', null)
    .maybeSingle()
  const karaId = (karaRow as { id: string } | null)?.id
  check('a pending rename targets the Kara Lee person id -> Karalea', Boolean(karaId) && renames.get(karaId!) === 'Karalea')
  const people = await listPeople({ supabase: svc, userId })
  const karalea = people.find((p) => p.name === 'Karalea')
  const staleKaraLee = people.find((p) => p.name === 'Kara Lee')
  check('the contact list now displays "Karalea"', Boolean(karalea), 'no Karalea row found')
  check('that row is flagged pendingRename', Boolean(karalea?.pendingRename))
  check('no stale "Kara Lee" display remains', !staleKaraLee)
  check('Karalea splits to first=Karalea, last=empty', karalea?.first === 'Karalea' && karalea?.last === '')
  // count: the overlay must not create a duplicate (still one row for this person)
  const karaCount = people.filter((p) => p.name === 'Karalea').length
  check('no duplicate row introduced by the overlay', karaCount === 1)

  console.log('\n== capture-with-target shape ==')
  check('person target needs an id', parseTarget('person', 'abc')?.id === 'abc' && parseTarget('person', '') === null)
  check('commitment target needs an id', parseTarget('commitment', 'x')?.kind === 'commitment' && parseTarget('commitment', null) === null)
  check('topic target needs no id', parseTarget('topic', null)?.kind === 'topic')
  check('unknown kind is rejected', parseTarget('place', 'x') === null)

  console.log('\n== sending layer still gone (no regression) ==')
  for (const f of ['lib/google/gmail.ts', 'app/api/google/connect/route.ts', 'lib/companion/draft.ts']) {
    check(`${f} stays deleted`, !existsSync(f))
  }
  check('writeCapture accepts a target', /targetKind\?: CaptureTargetKind/.test(readFileSync('lib/captures.ts', 'utf8')))
  check('the miner reads + injects the target', /resolveTargetLine/.test(readFileSync('packages/miner-core/src/extract.ts', 'utf8')))
  check('corrections compute ids via the shared first+last helper (lockstep)', /canonicalPersonId/.test(readFileSync('packages/miner-core/src/corrections.ts', 'utf8')))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
