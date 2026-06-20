// Pure tests for follow-up time-sensitivity (no DB, no model). Covers inference, the
// user override, and the read-time "passed" determination that drives the hygiene
// split (main tab vs the past view).
//
// Run: npx tsx scripts/check-timing.ts
import { resolveTiming, inferredDeadline } from '../lib/companion/timing'

let pass = 0
let fail = 0
const check = (n: string, c: boolean, d = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const NOW = Date.parse('2026-06-20T18:00:00Z')
const r = (data: Record<string, unknown>, overrideTimeSensitive: boolean | null = null, overrideDeadline: string | null = null) =>
  resolveTiming({ data, overrideTimeSensitive, overrideDeadline, now: NOW })

console.log('== inference ==')
check('data.deadline (ISO) is the deadline', inferredDeadline({ deadline: '2026-07-01' }) === '2026-07-01')
check('a concrete date in free-text due is picked up', inferredDeadline({ due: 'by 2026-06-25 please' }) === '2026-06-25')
check('YYYY-MM resolves to end of month', inferredDeadline({ deadline: '2026-02' }) === '2026-02-28')
check('a fuzzy/relative due has no concrete deadline', inferredDeadline({ due: 'tomorrow' }) === null)
check('no date fields => no deadline', inferredDeadline({ status: 'open' }) === null)

console.log('\n== time-sensitivity flag (deadline presence, anti over-tag) ==')
check('a concrete deadline => time-sensitive', r({ deadline: '2026-07-01' }).timeSensitive === true)
check('an evergreen nudge (no date) => NOT time-sensitive', r({ due: 'sometime' }).timeSensitive === false)
check('"call your dad" (no date) => not time-sensitive, not passed', (() => { const t = r({}); return !t.timeSensitive && !t.passed })())

console.log('\n== passed / hygiene split ==')
check('a future deadline is NOT passed', r({ deadline: '2026-07-01' }).passed === false)
check('a past deadline IS passed', r({ deadline: '2026-06-10' }).passed === true)
check('due TODAY is not passed until day end', r({ deadline: '2026-06-20' }).passed === false)
check('a past deadline that is not time-sensitive (override false) is NOT passed', r({ deadline: '2026-06-10' }, false).passed === false)

console.log('\n== user override ==')
check('user deadline wins over the inferred one', r({ deadline: '2026-07-01' }, null, '2026-06-10T00:00:00Z').passed === true)
check('user marks not time-sensitive => exempt from hygiene', r({ deadline: '2026-06-10' }, false).timeSensitive === false)
check('user marks time-sensitive with no deadline => sensitive, never passes', (() => { const t = r({}, true); return t.timeSensitive && !t.passed })())

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
