// Pure checks for the miner page-size / token budget (no DB, no model), locking the
// anti-truncation fix: the verbose node types (people/facts/insights) page SMALLER
// than the lighter types, so a single page + high-effort thinking cannot exceed
// MINER_MAX_TOKENS (which is why the canonical_people full pass truncated at
// stop_reason=max_tokens). Run: npx tsx scripts/check-page-limit.ts
import { pageLimit, MAX_TOKENS } from '../packages/miner-core/src/config'

// pageLimit reads env per call, so control it for deterministic defaults.
delete process.env.MINER_PAGE_SIZE
delete process.env.MINER_VERBOSE_PAGE_SIZE

let pass = 0
let fail = 0
const check = (n: string, c: boolean, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) } }

console.log('== default per-table page size ==')
check('verbose canonical_people pages smaller (15)', pageLimit('canonical_people') === 15, String(pageLimit('canonical_people')))
check('verbose canonical_facts pages smaller (15)', pageLimit('canonical_facts') === 15)
check('verbose insights pages smaller (15)', pageLimit('insights') === 15)
check('lighter canonical_places_orgs keeps 40', pageLimit('canonical_places_orgs') === 40, String(pageLimit('canonical_places_orgs')))
check('lighter canonical_relationships keeps 40', pageLimit('canonical_relationships') === 40)
check('no table = global default 40', pageLimit() === 40)
check('verbose page < lighter page (the whole point)', pageLimit('canonical_people') < pageLimit('canonical_places_orgs'))

console.log('\n== env overrides ==')
process.env.MINER_VERBOSE_PAGE_SIZE = '8'
check('MINER_VERBOSE_PAGE_SIZE overrides the verbose page', pageLimit('canonical_people') === 8)
check('MINER_VERBOSE_PAGE_SIZE does not touch lighter types', pageLimit('canonical_places_orgs') === 40)
delete process.env.MINER_VERBOSE_PAGE_SIZE

process.env.MINER_PAGE_SIZE = '10'
check('MINER_PAGE_SIZE lowers the global base', pageLimit() === 10 && pageLimit('canonical_places_orgs') === 10)
check('verbose page is min(base, 15) so it never exceeds the base', pageLimit('canonical_people') === 10)
delete process.env.MINER_PAGE_SIZE

process.env.MINER_PAGE_SIZE = '60'
check('a larger base still caps the verbose page at 15', pageLimit('canonical_people') === 15 && pageLimit('canonical_places_orgs') === 60)
delete process.env.MINER_PAGE_SIZE

console.log('\n== token ceiling ==')
// MAX_TOKENS is read at module load; assert it is a sane positive ceiling. The
// default (no MINER_MAX_TOKENS) is 40000, raised from 24000 now that callClaude
// streams (the non-streaming >10-min refusal that capped it is gone).
check('MAX_TOKENS is a positive ceiling', Number.isFinite(MAX_TOKENS) && MAX_TOKENS >= 24000, String(MAX_TOKENS))
if (!process.env.MINER_MAX_TOKENS) check('MAX_TOKENS default is 40000', MAX_TOKENS === 40000, String(MAX_TOKENS))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
