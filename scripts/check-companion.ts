// Offline checks for the revised (conversational) companion. No model call and no
// external send, so it runs under the current usage limit. It asserts the sending
// layer is gone, unit-tests the label-drift overlay re-match and the relationship
// heuristic, exercises getToday against the real graph, and confirms the brainstorm
// is server-side.
//
// Run: npx tsx scripts/check-companion.ts
import { existsSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { bucketOf, getToday } from '../lib/companion/today'
import { matchOverlay, type CommitmentRef, type OverlayRow } from '../lib/companion/overlay'
import { closenessWeight, relationshipNudges } from '../lib/companion/nudges'

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
const read = (p: string) => readFileSync(p, 'utf8')

async function main() {
  const now = Date.parse('2026-06-19T12:00:00Z')

  console.log('== sending layer is gone (deferred to a later connectors build) ==')
  for (const f of [
    'lib/google/gmail.ts',
    'lib/google/calendar.ts',
    'lib/google/oauth.ts',
    'lib/google/connection.ts',
    'lib/companion/draft.ts',
    'app/api/google/connect/route.ts',
  ]) {
    check(`${f} no longer exists`, !existsSync(f))
  }
  const actionsSrc = read('app/companion/actions.ts')
  check('actions.ts has no email/calendar send action', !/sendEmail|createEvent|draftEmail|draftCalendar|sendGmail/.test(actionsSrc))
  const viewSrc = read('components/companion/companion-view.tsx')
  check('companion view has no gmail/calendar/connect UI', !/gmail|calendar|google\/connect|Send email|Create event/i.test(viewSrc))
  const migration = read('supabase/migrations/0011_companion_conversational.sql')
  check('migration drops google_connections', /drop table if exists public\.google_connections/.test(migration))
  check('migration drops companion_actions', /drop table if exists public\.companion_actions/.test(migration))
  check('migration adds the overlay match columns', /add column if not exists match_label/.test(migration) && /add column if not exists match_person_id/.test(migration))

  console.log('\n== label-drift overlay re-match (the fix) ==')
  {
    // a commitment that re-resolved under a NEW id after its label drifted
    const drifted: CommitmentRef = { id: 'NEW_ID_AAA', label: 'Have dinner with Todd', personId: 'P_TODD' }
    const overlayFromBefore: OverlayRow = {
      commitment_id: 'OLD_ID_ZZZ', // the pre-drift id, no longer a current commitment
      state: 'done',
      snooze_until: null,
      match_label: 'Get dinner with Todd',
      match_person_id: 'P_TODD',
      due_date: null,
      linked_person_id: null,
    }
    const m = matchOverlay([drifted], [overlayFromBefore])
    check('drifted commitment re-matches its overlay (state survives drift)', m.get('NEW_ID_AAA')?.state === 'done')

    const exact: CommitmentRef = { id: 'SAME', label: 'whatever', personId: null }
    const exactOverlay: OverlayRow = { commitment_id: 'SAME', state: 'snoozed', snooze_until: null, match_label: 'x', match_person_id: null, due_date: null, linked_person_id: null }
    check('exact id still matches', matchOverlay([exact], [exactOverlay]).get('SAME')?.state === 'snoozed')

    const wrongPerson: OverlayRow = { commitment_id: 'OLD2', state: 'done', snooze_until: null, match_label: 'Have dinner with Todd', match_person_id: 'P_SOMEONE_ELSE', due_date: null, linked_person_id: null }
    check('person disagreement blocks a fuzzy match', matchOverlay([drifted], [wrongPerson]).get('NEW_ID_AAA') === undefined)

    const unrelated: OverlayRow = { commitment_id: 'OLD3', state: 'done', snooze_until: null, match_label: 'buy a new surfboard', match_person_id: null, due_date: null, linked_person_id: null }
    check('an unrelated label does not falsely match', matchOverlay([drifted], [unrelated]).get('NEW_ID_AAA') === undefined)

    const noSignature: OverlayRow = { commitment_id: 'OLD4', state: 'done', snooze_until: null, match_label: null, match_person_id: null, due_date: null, linked_person_id: null }
    check('overlay without a stored signature cannot fuzzy-match (no false positive)', matchOverlay([drifted], [noSignature]).get('NEW_ID_AAA') === undefined)

    // person-less matches need MUCH stronger label agreement (the review fix)
    const giftCommit: CommitmentRef = { id: 'G1', label: 'buy birthday gift', personId: null }
    const giftOverlay: OverlayRow = { commitment_id: 'OLDG', state: 'done', snooze_until: null, match_label: 'buy holiday gift', match_person_id: null, due_date: null, linked_person_id: null }
    check('person-less weak overlap (Jaccard 0.5) NO LONGER carries state across items', matchOverlay([giftCommit], [giftOverlay]).get('G1') === undefined)
    const gymCommit: CommitmentRef = { id: 'GY1', label: 'Renew gym membership', personId: null }
    const gymOverlay: OverlayRow = { commitment_id: 'OLDGY', state: 'snoozed', snooze_until: null, match_label: 'Renew the gym membership', match_person_id: null, due_date: null, linked_person_id: null }
    check('person-less STRONG overlap still re-matches', matchOverlay([gymCommit], [gymOverlay]).get('GY1')?.state === 'snoozed')
  }

  console.log('\n== relationship heuristic ==')
  check('best friend scores high', closenessWeight({ label: 'Cole', closeness: 'best buddy', relationship: 'best friend' }) === 3)
  check('family scores high', closenessWeight({ label: 'Mom', closeness: '', relationship: 'mother' }) === 3)
  check('acquaintance is not nudged (weight 0)', closenessWeight({ label: 'X', closeness: 'acquaintance', relationship: 'acquaintance' }) === 0)
  check('a pure work tie (business partner) is not nudged', closenessWeight({ label: 'Sam', closeness: '', relationship: 'business partner' }) === 0)
  check('a relationship keyword in the NAME is not read as closeness', closenessWeight({ label: 'Brother Lee', closeness: '', relationship: 'acquaintance' }) === 0)
  const nudges = await relationshipNudges({ supabase: svc, userId }, now)
  console.log(`  surfaced ${nudges.length} relationship nudge(s):`)
  for (const n of nudges) console.log(`   - ${n.name} | ${n.suggestion}`)
  check('relationship nudges return close people with a plain-language suggestion', nudges.length >= 1 && nudges.every((n) => n.suggestion.length > 10))
  check('every nudge is about a person who clearly matters (not an acquaintance)', nudges.every((n) => n.name))

  console.log('\n== getToday against the live graph (phrased follow-ups) ==')
  const today = await getToday({ supabase: svc, userId }, now)
  console.log('  counts:', JSON.stringify(today.counts))
  const sample = [...today.overdue, ...today.soon, ...today.open].slice(0, 4)
  for (const f of sample) console.log(`   - [${f.bucket}] ${f.headline} :: ${f.suggestion} | ${f.provenance ?? 'no prov'}`)
  check('today surfaces at least one phrased follow-up', today.counts.active >= 1)
  check('every follow-up has a plain-language suggestion (not a raw readout)', sample.every((f) => f.suggestion.toLowerCase().startsWith('you said')))
  check('relationship nudges are part of the surface', today.counts.nudges >= 1)
  check('done/dismissed are never surfaced as active', [...today.overdue, ...today.soon, ...today.open].every((f) => f.status !== 'done' && f.status !== 'dismissed'))

  console.log('\n== bucketOf (unchanged, free-text best-effort) ==')
  check('elapsed snooze resurfaces as overdue', bucketOf('whenever', '2026-06-18T00:00:00Z', now) === 'overdue')
  check('"tomorrow" is soon', bucketOf('tomorrow', null, now) === 'soon')
  check('unknown free text is open', bucketOf('in a couple weeks', null, now) === 'open')

  console.log('\n== brainstorm is server-side and does not send ==')
  check('brainstorm route exists', existsSync('app/api/companion/brainstorm/route.ts'))
  const brainstormSrc = read('lib/companion/brainstorm.ts')
  check('brainstorm prompt states it cannot send', /do NOT send|cannot: you brainstorm|never send/i.test(brainstormSrc))
  check('brainstorm route runs server-side (runtime nodejs, reuses runChat)', /runtime = 'nodejs'/.test(read('app/api/companion/brainstorm/route.ts')) && /runChat/.test(read('app/api/companion/brainstorm/route.ts')))
  check('runChat accepts a systemPrompt override', /systemPrompt\?: string/.test(read('lib/chat/agent.ts')))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
