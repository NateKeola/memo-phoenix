// Offline checks for the freshness loop (spec §3, PR8). Pure deterministic logic,
// no model call and no database, so it runs under the current Anthropic usage
// limit. It verifies the four mechanisms:
//   - confidence decay by temporal class (read-time, anchored on last_confirmed_at)
//   - salience scoring from documented graph signals
//   - reconfirm selection (decay + salience thresholds)
//   - supersession planning from the model's discrepancy output
//
// The end-to-end (mine a real corpus, fold an interview answer back as a renewal
// or supersession) needs a miner run, blocked by the Anthropic usage limit until
// 2026-07-01. That is the user's acceptance check.
//
// Run: npx tsx scripts/check-freshness.ts
import {
  effectiveConfidence,
  isReconfirmCandidate,
  reconfirmPriority,
  isAged,
  ageDays,
  HALF_LIFE_DAYS,
} from '../lib/freshness/decay'
import { computeSalience, newestClaimMs, planSupersessions } from '../packages/miner-core/src/freshness'
import type { DiscrepancyItem } from '../packages/miner-core/src/types'

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
const approx = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps

const DAY = 86_400_000
const NOW = Date.parse('2026-06-19T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString()
const HL = HALF_LIFE_DAYS.decaying // 45 by default

console.log('== decay by temporal class ==')
{
  const base = 0.8
  const evergreen = { temporality: 'evergreen', confidence: base, lastConfirmedAt: daysAgo(400) }
  check('evergreen never decays', effectiveConfidence(evergreen, NOW) === base)

  const noAnchor = { temporality: 'decaying', confidence: base, lastConfirmedAt: null }
  check('decaying with no anchor returns base (cannot decay)', effectiveConfidence(noAnchor, NOW) === base)

  const fresh = { temporality: 'decaying', confidence: base, lastConfirmedAt: daysAgo(0) }
  check('decaying just confirmed ~= base', approx(effectiveConfidence(fresh, NOW), base))

  const oneHL = { temporality: 'decaying', confidence: base, lastConfirmedAt: daysAgo(HL) }
  check('decaying at one half-life ~= base/2', approx(effectiveConfidence(oneHL, NOW), base / 2))

  const twoHL = { temporality: 'decaying', confidence: base, lastConfirmedAt: daysAgo(HL * 2) }
  check('decaying at two half-lives ~= base/4', approx(effectiveConfidence(twoHL, NOW), base / 4))

  const t1 = effectiveConfidence({ temporality: 'decaying', confidence: base, lastConfirmedAt: daysAgo(10) }, NOW)
  const t2 = effectiveConfidence({ temporality: 'decaying', confidence: base, lastConfirmedAt: daysAgo(40) }, NOW)
  const t3 = effectiveConfidence({ temporality: 'decaying', confidence: base, lastConfirmedAt: daysAgo(90) }, NOW)
  check('decaying is monotonically lower the longer since confirmation', t1 > t2 && t2 > t3)
  check('ageDays computes days since last confirmation', Math.round(ageDays(daysAgo(30), NOW) ?? -1) === 30)
}

console.log('\n== aged marking (retrieval) ==')
{
  check(
    'a decaying fact unconfirmed long enough is aged',
    isAged({ temporality: 'decaying', confidence: 0.8, lastConfirmedAt: daysAgo(120) }, NOW)
  )
  check(
    'a freshly confirmed decaying fact is not aged',
    !isAged({ temporality: 'decaying', confidence: 0.8, lastConfirmedAt: daysAgo(2) }, NOW)
  )
  check(
    'an evergreen fact is never aged',
    !isAged({ temporality: 'evergreen', confidence: 0.4, lastConfirmedAt: daysAgo(900) }, NOW)
  )
}

console.log('\n== salience scoring ==')
{
  const trivia = computeSalience({ provenance: 1, degree: 0, references: 0, commitmentLoad: false })
  const central = computeSalience({ provenance: 4, degree: 4, references: 3, commitmentLoad: true })
  check('one-off trivia scores low', trivia < 0.2, `got ${trivia}`)
  check('a central, well-connected node scores ~1', approx(central, 1, 0.001), `got ${central}`)
  check('central > trivia', central > trivia)

  const d0 = computeSalience({ provenance: 2, degree: 0, references: 0, commitmentLoad: false })
  const d3 = computeSalience({ provenance: 2, degree: 3, references: 0, commitmentLoad: false })
  check('more graph degree raises salience', d3 > d0)

  const r0 = computeSalience({ provenance: 2, degree: 1, references: 0, commitmentLoad: false })
  const r3 = computeSalience({ provenance: 2, degree: 1, references: 3, commitmentLoad: false })
  check('more references raise salience', r3 > r0)

  const noCommit = computeSalience({ provenance: 2, degree: 1, references: 1, commitmentLoad: false })
  const commit = computeSalience({ provenance: 2, degree: 1, references: 1, commitmentLoad: true })
  check('being load-bearing for an open commitment raises salience', commit > noCommit)
  check('salience is clamped to [0,1]', central <= 1 && trivia >= 0)
}

console.log('\n== reconfirm selection ==')
{
  // decaying, salient, confirmed 60 days ago, base 0.7 -> faded under threshold
  const aging = { temporality: 'decaying', confidence: 0.7, salience: 0.6, lastConfirmedAt: daysAgo(60) }
  check('aging, salient, long-unconfirmed decaying node IS a reconfirm candidate', isReconfirmCandidate(aging, NOW))

  const evergreen = { temporality: 'evergreen', confidence: 0.7, salience: 0.9, lastConfirmedAt: daysAgo(300) }
  check('evergreen is never a reconfirm candidate', !isReconfirmCandidate(evergreen, NOW))

  const recent = { temporality: 'decaying', confidence: 0.7, salience: 0.6, lastConfirmedAt: daysAgo(5) }
  check('a recently confirmed decaying node is not surfaced (min-stale guard)', !isReconfirmCandidate(recent, NOW))

  const trivial = { temporality: 'decaying', confidence: 0.7, salience: 0.1, lastConfirmedAt: daysAgo(120) }
  check('a low-salience decaying node is not surfaced (salience gate)', !isReconfirmCandidate(trivial, NOW))

  const stillConfident = { temporality: 'decaying', confidence: 0.99, salience: 0.6, lastConfirmedAt: daysAgo(10) }
  check('a still-confident decaying node is not surfaced (confidence gate)', !isReconfirmCandidate(stillConfident, NOW))

  const moreFaded = reconfirmPriority({ temporality: 'decaying', confidence: 0.7, salience: 0.6, lastConfirmedAt: daysAgo(120) }, NOW)
  const lessFaded = reconfirmPriority({ temporality: 'decaying', confidence: 0.7, salience: 0.6, lastConfirmedAt: daysAgo(30) }, NOW)
  check('reconfirm priority is higher for a more faded node', moreFaded > lessFaded)
}

console.log('\n== supersession planning (from discrepancies) ==')
{
  const dates = new Map<string, number>([
    ['claimAustin', NOW - 200 * DAY], // old
    ['claimDenver', NOW - 5 * DAY], // new
    ['claimOther', NOW - 50 * DAY],
  ])
  const disc = (claim_ids: string[]): DiscrepancyItem => {
    return { subject: 'where the user lives', description: 'moved', claim_ids }
  }

  // two distinct current rows, older superseded onto newer
  {
    const rows = [
      { id: 'rowAustin', claims: ['claimAustin'] },
      { id: 'rowDenver', claims: ['claimDenver'] },
    ]
    const plan = planSupersessions(rows, [disc(['claimAustin', 'claimDenver'])], dates)
    check('older contradicted row is superseded onto the newer', plan.get('rowAustin') === 'rowDenver')
    check('newer (survivor) row is not superseded', !plan.has('rowDenver'))
    check('exactly one supersession', plan.size === 1)
  }

  // model merged the conflict into ONE row -> nothing to supersede
  {
    const rows = [{ id: 'rowMerged', claims: ['claimAustin', 'claimDenver'] }]
    const plan = planSupersessions(rows, [disc(['claimAustin', 'claimDenver'])], dates)
    check('a merged conflict (one row) supersedes nothing', plan.size === 0)
  }

  // a tie in newest date -> no strictly-older loser
  {
    const tieDates = new Map<string, number>([
      ['claimA', NOW - 30 * DAY],
      ['claimB', NOW - 30 * DAY],
    ])
    const rows = [
      { id: 'rowA', claims: ['claimA'] },
      { id: 'rowB', claims: ['claimB'] },
    ]
    const plan = planSupersessions(rows, [disc(['claimA', 'claimB'])], tieDates)
    check('a same-date tie supersedes nothing (no strictly-older)', plan.size === 0)
  }

  // discrepancy claims that no current row cites -> nothing
  {
    const rows = [{ id: 'rowX', claims: ['claimOther'] }]
    const plan = planSupersessions(rows, [disc(['claimAustin', 'claimDenver'])], dates)
    check('discrepancy with no matching current rows supersedes nothing', plan.size === 0)
  }

  // three rows: the two older both retire onto the newest
  {
    const d3 = new Map<string, number>([
      ['c1', NOW - 300 * DAY],
      ['c2', NOW - 100 * DAY],
      ['c3', NOW - 1 * DAY],
    ])
    const rows = [
      { id: 'r1', claims: ['c1'] },
      { id: 'r2', claims: ['c2'] },
      { id: 'r3', claims: ['c3'] },
    ]
    const plan = planSupersessions(rows, [disc(['c1', 'c2', 'c3'])], d3)
    check('with three contradicting rows, both older ones retire onto the newest', plan.get('r1') === 'r3' && plan.get('r2') === 'r3' && plan.size === 2)
  }

  // idempotency: once only the survivor is current, a re-run plans nothing
  {
    const rows = [{ id: 'rowDenver', claims: ['claimDenver'] }]
    const plan = planSupersessions(rows, [disc(['claimAustin', 'claimDenver'])], dates)
    check('idempotent: with only the survivor current, nothing is re-superseded', plan.size === 0)
  }
}

console.log('\n== newestClaimMs ==')
{
  const m = new Map<string, number>([
    ['a', 100],
    ['b', 300],
    ['c', 200],
  ])
  check('newestClaimMs picks the max date', newestClaimMs(['a', 'b', 'c'], m) === 300)
  check('newestClaimMs ignores unknown ids', newestClaimMs(['a', 'zzz'], m) === 100)
  check('newestClaimMs returns null for no resolvable dates', newestClaimMs(['zzz'], m) === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
