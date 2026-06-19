// Offline checks for the companion core (no model call, no external send, so it
// runs under the current Anthropic usage limit and never touches Gmail/Calendar).
// It exercises the DETERMINISTIC today selection against the real graph, unit-tests
// the bucketing, and STRUCTURALLY asserts the safety boundary: the model-drafting
// path cannot send, and the send path is code-gated and model-free.
//
// companion_state / google_connections / companion_actions land on merge (migrate
// on merge to main), so getToday degrades to no overlay here; that is expected.
//
// Run: npx tsx scripts/check-companion.ts
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { bucketOf, getToday } from '../lib/companion/today'

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
function read(path: string): string {
  return readFileSync(path, 'utf8')
}

async function main() {
  const now = Date.parse('2026-06-18T12:00:00Z')

  console.log('== bucketOf (deterministic, best-effort over free-text dues) ==')
  check('elapsed snooze resurfaces as overdue', bucketOf('whenever', '2026-06-17T00:00:00Z', now) === 'overdue')
  check('future snooze does not force overdue', bucketOf('tomorrow', '2026-07-01T00:00:00Z', now) === 'soon')
  check('"tomorrow" is soon', bucketOf('tomorrow', null, now) === 'soon')
  check('"yesterday" is overdue', bucketOf('yesterday', null, now) === 'overdue')
  check('past ISO date is overdue', bucketOf('by 2025-01-10', null, now) === 'overdue')
  check('far ISO date is open', bucketOf('2027-01-10', null, now) === 'open')
  check('unknown free text is open', bucketOf('in a couple weeks', null, now) === 'open')
  check('no due is open', bucketOf(null, null, now) === 'open')

  console.log('\n== getToday against the live graph (overlay degrades, expected) ==')
  const today = await getToday({ supabase: svc, userId }, now)
  console.log('  counts:', JSON.stringify(today.counts))
  console.log(`  overdue ${today.overdue.length} / soon ${today.soon.length} / open ${today.open.length} / snoozed ${today.snoozed.length} / events ${today.upcomingEvents.length}`)
  const sample = [...today.overdue, ...today.soon, ...today.open].slice(0, 4)
  for (const f of sample) console.log(`   - [${f.bucket}] ${f.label} | for ${f.person?.label ?? 'none'} | due ${f.due ?? 'n/a'} | ${f.provenance ?? 'no provenance'}`)
  check('today surfaced at least one open commitment from the real graph', today.counts.active >= 1)
  check('every surfaced item carries provenance or a clear null', sample.every((f) => 'provenance' in f))
  check('done/dismissed are never surfaced as active', [...today.overdue, ...today.soon, ...today.open].every((f) => f.status !== 'done' && f.status !== 'dismissed'))

  console.log('\n== SAFETY BOUNDARY: drafting cannot send; sending is code-gated and model-free ==')
  const draftSrc = read('lib/companion/draft.ts')
  check('draft.ts does not import gmail', !/google\/gmail/.test(draftSrc))
  check('draft.ts does not import calendar', !/google\/calendar/.test(draftSrc))
  check('draft.ts does not import the connection/token module', !/google\/connection/.test(draftSrc))

  const actionsSrc = read('app/companion/actions.ts')
  const sendBlock = actionsSrc.slice(actionsSrc.indexOf('export async function sendEmailAction'))
  const emailFn = sendBlock.slice(0, sendBlock.indexOf('export async function createEventAction'))
  const eventFn = sendBlock.slice(sendBlock.indexOf('export async function createEventAction'))
  check('sendEmailAction requires explicit confirm', /input\.confirm !== true/.test(emailFn))
  check('createEventAction requires explicit confirm', /input\.confirm !== true/.test(eventFn))
  check('sendEmailAction never calls the drafting model', !/draftEmail|draftCalendar/.test(emailFn))
  check('createEventAction never calls the drafting model', !/draftEmail|draftCalendar/.test(eventFn))
  check('send path goes through the Gmail helper', /sendGmail\(/.test(emailFn))
  check('create path goes through the Calendar helper', /createCalendarEvent\(/.test(eventFn))
  check('send/create require a live access token (connection gate)', /getValidAccessToken/.test(emailFn) && /getValidAccessToken/.test(eventFn))

  console.log('\n== token isolation: tokens are server-only ==')
  const connSrc = read('lib/google/connection.ts')
  check('connection.ts is server-only', /^import 'server-only'/.test(connSrc))
  check('google_connections is only touched via the admin (service-role) client', /createAdminClient/.test(connSrc))
  const migration = read('supabase/migrations/0010_companion.sql')
  // isolate just the google_connections statements (from its CREATE TABLE to the
  // next CREATE TABLE) so the assertion is not fooled by other tables' policies.
  const gcStart = migration.indexOf('create table public.google_connections')
  const gcEnd = migration.indexOf('create table public.companion_actions')
  const gcBlock = migration.slice(gcStart, gcEnd)
  check('google_connections has FORCE RLS', /force row level security/.test(gcBlock))
  check('google_connections has NO policies (service-role only)', !/create policy/.test(gcBlock))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
