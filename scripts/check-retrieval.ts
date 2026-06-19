// Offline check for the chat retrieval tools (no model call, so it runs under the
// current Anthropic usage limit). Exercises every deterministic tool against the
// real graph and prints what the composer would receive for the canonical
// questions. Also re-demonstrates RLS scoping (an anon, no-session client sees
// zero rows).
//
// Run: npx tsx scripts/check-retrieval.ts
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  findCommitments,
  getPerson,
  getProject,
  getProvenance,
  listRecent,
  listUpcoming,
  neighborsOf,
  searchFacts,
  type RetrievalDeps,
} from '../lib/chat/retrieval'

// minimal .env.local loader (no dotenv dependency)
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const userId = process.env.MEMO_USER_ID!

// Service-role client + explicit user_id filter == the production RLS view for the
// single user (the tools always pass .eq('user_id', userId)).
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })
const deps: RetrievalDeps = { supabase, userId }

function show(title: string, value: unknown) {
  console.log(`\n===== ${title} =====`)
  console.log(JSON.stringify(value, null, 2))
}

async function main() {
  console.log('userId:', userId)

  // 1. what am I working on
  const projects = await getProject(deps)
  show('what am I working on -> get_project()', projects.map((p) => ({ label: p.label, status: (p.data as { status?: string }).status, provenance: p.provenance })))

  // 2. who is Karalea (fuzzy: alias / spelling)
  const karalea = await getPerson(deps, 'Karalea')
  show('who is Karalea -> get_person("Karalea")', karalea.map((p) => ({ label: p.label, relationship: (p.data as { relationship?: string }).relationship, summary: p.summary, provenance: p.provenance })))

  // 3. what do I owe people
  const owed = await findCommitments(deps, {})
  show('what do I owe -> find_commitments()', owed.map((c) => ({ label: c.label, due: c.due, status: c.status, person: c.person, provenance: c.provenance })))

  // 4. what is coming up
  const upcoming = await listUpcoming(deps)
  show('what is coming up -> list_upcoming()', {
    events: upcoming.events.map((e) => ({ label: e.label, date: e.date, location: e.location })),
    commitments: upcoming.commitments.map((c) => ({ label: c.label, due: c.due })),
  })

  // 5. facts + insights search
  const facts = await searchFacts(deps, 'volleyball surfing', true)
  show('search_facts("volleyball surfing", insights)', facts.map((f) => ({ type: f.type, label: f.label, current: f.current, provenance: f.provenance })))

  // 6. neighbors_of a real person id (use the top Karalea/first project related id if present)
  const anchor = karalea[0]?.id
  if (anchor) {
    const neighbors = await neighborsOf(deps, anchor)
    show(`neighbors_of(${anchor})`, { center: neighbors.center, edges: neighbors.edges.slice(0, 6) })
  }

  // 7. provenance x-ray on a real claim
  const claim = projects[0]?.source_claim_ids?.[0]
  if (claim) {
    const prov = await getProvenance(deps, [claim])
    show(`get_provenance(["${claim}"])`, prov.sources.map((s) => ({ mode: s.mode, date: s.date, snippet: s.snippet.slice(0, 100) })))
  }

  // 8. list_recent insights
  const recentInsights = await listRecent(deps, 'insight', 3)
  show('list_recent("insight", 3)', recentInsights.map((r) => ({ label: r.label, salience: r.confidence, summary: (r.summary ?? '').slice(0, 90) })))

  // RLS proof: an anon client with no session must see zero canonical rows.
  const anon = createClient(url, anonKey, { auth: { persistSession: false } })
  const { data: anonRows } = await anon.from('canonical_people').select('id').limit(5)
  console.log('\n===== RLS proof =====')
  console.log('anon (no session) canonical_people rows visible:', anonRows ? anonRows.length : 'blocked')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
