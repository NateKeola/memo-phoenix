# Memo Phoenix — Product & Architecture Spec

**Version:** 0.1 (MVP) **Date:** 2026-06-16 **Status:** Architecture converged; a small set of choices intentionally deferred to real-capture observation (see §15) **Scope:** The full Memo Phoenix application: capture surface, personal interview agent, the backend miner re-pointed at a personal corpus, the self-refreshing freshness loop, the baseline trainer, the contact sheet, retrieval, and the companion core. Built as a clean standalone project that reuses the Miine engine and the harness pattern by copying, not by sharing a live codebase.

---

**Reading instructions for the implementing agent (Claude Code):** This document tags decisions with a doneness state.

- **\[LOCKED\]** items are constraints. Implement them as written.  
- **\[OPEN-BLOCKING\]** items must be resolved with Todd before any code is written that depends on them. Ask, do not assume.  
- **\[OPEN-EXPLORATORY\]** items want a recommendation confirmed or a 2 to 4 option pick surfaced for Todd. Do not silently pick one and build to it.  
- If an item has no tag, treat it as **\[OPEN-BLOCKING\]** and ask before building. Do not treat unmarked structure (headers, tables, DDL, prose) as license to expand scope beyond tagged items. The DDL below is illustrative of intent. Column-level choices marked open are not yet ordained. The version axis here is **exists vs pretty**: V0 means every listed feature works end to end and unpolished. V1 means polish and tuning. Build the V0 surface of a feature, then stop. Do not gold-plate a V0 feature with V1 polish.

---

## 0\. What this is, and boundaries

Memo Phoenix is a single-user personal knowledge and companion system. It runs three loops over one shared corpus:

- **Capture.** Low-friction brain dump, by voice memo, typed text, or a spoken interview, available at any time. Frictionless capture is the north star.  
- **Extract and refresh.** A backend miner turns captures into a personal knowledge graph, and keeps that graph fresh by folding aging facts back into your next conversation (see §3).  
- **Act.** A companion layer tracks people and commitments, surfaces what needs follow-up, and drafts the action for you to confirm.

**In scope:** the application above, end to end, single user.

**Out of scope** (named so the boundary is explicit, do not build from this spec):

- Multi-user, teams, sharing. The tenancy pattern is preserved (§2) so it is not painful to add later, but no multi-user UX ships.  
- Autonomous send or scheduling without confirmation. V0 is draft and confirm only (§9).  
- Native iOS. Web and PWA first (§6).  
- A re-mining or model-upgrade reprocessing loop. Captured for V2+ (§12).

**Relationship to Miine.** Memo Phoenix is its own world: a new repo (created), its own Supabase project, its own Vercel project, separate credentials. The Miine repo is read-only reference. Reuse happens by copying the specific pieces (`miner-core`, the interview and briefing scaffold, the provenance viewer, the harness pattern) into the new repo as a starting point. There is no shared codebase and no path for this project's tooling to touch Miine's canonical Supabase project. This mirrors the product-world vs generated-world separation already used for AutoFDE.

---

## 1\. Versioning model: exists vs pretty \[LOCKED\]

- **V0 \= every feature exists and works, unpolished.** Nothing on the feature list is dropped or deferred to V1. The deferral discipline operates per feature, not per feature-set: build the smallest functional surface of each thing, reuse over rebuild, then stop.  
- **V1 \= make it pretty and tune it.** Visual polish, threshold tuning from real usage, autonomous actions graduating from draft-and-confirm, proactive push.  
- **V2+ \= captured, not designed.** iOS, multi-user, cross-surface presence, re-mining.

The point of stating this explicitly: a maximal interpretation of any V0 feature is over-build. A V0 feature is shippable and correct, not finished.

---

## 2\. Architecture overview

Single user. The tenancy key is `user_id` swapped in for Miine's `company_id`, and RLS stays on every table (security by default, free because we are copying the pattern, and future-proof if this ever opens up). No multi-user UX.

The data spine:

```
captures (append-only)
corrections (append-only)        →  MINER  →  canonical layer  →  consumers:
confirmations (append-only)         (A→B→C,    (personal types,    - chat / search (gated)
                                     recompute  collections,        - contact sheet
                                     from raw)  temporally typed,    - companion core
                                                validity intervals)  - the freshness loop
```

The backend follows the harness doctrine from the Agent\_Harnesses notes:

- The LLM is one stage of a deterministic pipeline, not the orchestrator. Routing is code wherever code can decide it.  
- High-stakes transitions (sending an email, booking a meeting) are hard-gated in code, never left to a system-prompt instruction.  
- System prompts are cached (pad past 4096 tokens, `cache_control: ephemeral`).  
- Tools are small and named for what they do.  
- Telemetry from day one (tool calls, miner runs, cache hit rates).  
- Direct Anthropic SDK. No LangChain. (Consistent with existing Miine practice.)

```
flowchart TD
  CAP["captures (text / voice memo / interview transcript)"]
  COR["corrections (your explicit fixes)"]
  CON["confirmations (freshness loop answers)"]
  RAW["raw_* tables (append-only, provenance)"]
  MINER["MINER: Stage A → B → C\nrecompute from full ground-truth set"]
  CANON["canonical layer\npersonal types + collections\ntemporal class + validity intervals + salience"]
  AUX["aux: open_threads, discrepancies\nreconfirm candidates (computed)"]
  CHAT["chat / search (gated by baseline)"]
  CONTACTS["contact sheet"]
  COMP["companion core\nbriefing injection + in-interface prompts + draft/confirm actions"]

  CAP --> RAW
  COR --> MINER
  CON --> MINER
  RAW --> MINER --> CANON
  MINER --> AUX
  CANON --> CHAT
  CANON --> CONTACTS
  CANON --> COMP
  AUX --> COMP
  COMP -. "injects 'is this still true?' into next interview" .-> CAP
  COMP -. "writes confirmations" .-> CON
```

---

## 3\. The self-refreshing corpus (freshness mechanism) \[LOCKED design\]

This is the novel core. The corpus does not rot because the thing that fills it also maintains it. Freshness is a byproduct of the extraction loop, not a separate cron janitor.

**The problem.** A personal corpus runs indefinitely and tracks fast-moving life state. Recompute-from-raw grounds everything in ground truth, but raw is append-only and never wrong: a true claim from March ("I work at Miine") is still true raw in December. Naive re-derivation keeps superseded facts alive next to current ones. You need supersession, not deletion, plus a way to know which aging facts are worth refreshing.

**The mechanism, four parts:**

1. **Validity intervals and supersession.** Every canonical fact carries `valid_from`, `valid_to` (null means current), and `superseded_by`. When a newer raw claim contradicts an older one, the miner closes the old fact's window and points it at its successor rather than holding both as current. This resolves what Miine merely flags as a discrepancy into a temporal fact.  
2. **Confidence decay by temporal class.** Every node is classed `evergreen`, `dated`, or `decaying`. Evergreen never decays (a birthday, a best friend's mother's name). Dated has a due date and archives after it. Decaying loses confidence on a half-life (current projects, recent moods, who you have been seeing). A fact below threshold is not deleted, it becomes a refresh candidate.  
3. **Re-confirmation through the existing conversation loop.** Aging, high-value facts are folded into your next interview as lightweight confirmations, via the same briefing-injection path the companion uses (§9). The briefing agent slips a couple of "is this still true?" checks into the session's system prompt. Your answer writes a fresh raw claim that either renews the fact's validity (resets the decay clock, updates `last_confirmed_at`) or supersedes it. The builder is the maintainer.  
4. **Salience gating.** Re-confirmation only fires for nodes that earn it: high graph degree, frequently queried or referenced, or load-bearing for an open commitment. One-off trivia ages out quietly (archived, still in raw, recoverable). This keeps the companion from feeling like a chore.

**Retrieval is validity-aware too.** Even before re-confirmation happens, the structured tools (§10) prefer `valid_to IS NULL` facts and annotate aged ones ("as of March, you were..."), so the system never serves stale state as present tense.

**Relationship to corrections.** Corrections fix errors, the freshness loop fixes staleness. Both write append-only inputs the miner reads alongside raw. You never edit canonical directly. (See §4 for why this is load-bearing.)

Decay half-lives and salience thresholds are **\[OPEN-EXPLORATORY\]** (§15). The structure above is locked. The constants get tuned in V1 against real use.

---

## 4\. Data model

### 4.1 Conventions \[LOCKED\]

- Single `public` schema, table-name prefixes (`raw_*`, `canonical_*`), as in Miine MVP.  
- `uuid` primary keys. Deterministic UUIDv5 for canonical identity (reused from Miine).  
- Single-user: every row carries `user_id`. RLS on every table. Service role server-side only.  
- **Provenance is mandatory.** Every raw row carries `capture_id`. Every canonical row carries `source_claim_ids uuid[]` tracing to the raw rows it was synthesized from. Do not drop this. It is what makes the contact sheet trustworthy (§11).  
- **Temporal class is mandatory on canonical rows** (`evergreen | dated | decaying`), plus `valid_from`, `valid_to`, `superseded_by`, `confidence`, `last_confirmed_at`, and a computed `salience`.

### 4.2 Ground-truth input layer \[LOCKED that these are append-only\]

```sql
create table captures (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  mode          text not null,          -- 'memo' | 'text' | 'interview'
  modality      text not null,          -- 'voice' | 'text'
  body          text,                   -- typed text or STT transcript
  audio_url     text,                   -- memo / interview audio if retained
  routing_hint  text,                   -- optional: 'work' | 'personal' | freeform e.g. 'gift list'
  interview_id  uuid,                   -- set when mode = 'interview'
  created_at    timestamptz not null default now()
);

create table corrections (             -- your explicit fixes; miner input on every recompute
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  kind        text not null,            -- 'merge_people' | 'retype' | 'edit_fact' | 'not_a_commitment' | ...
  payload     jsonb not null,           -- structured instruction the miner honors
  created_at  timestamptz not null default now()
);

create table confirmations (           -- freshness-loop answers; miner input on every recompute
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  canonical_id  uuid,                   -- the node being confirmed / superseded
  result        text not null,          -- 'renew' | 'supersede' | 'unsure'
  payload       jsonb,                  -- the new claim, if superseding
  source_capture_id uuid,               -- the capture/interview turn this came from
  created_at    timestamptz not null default now()
);
```

`confirmations` and `corrections` could be unified into one typed `ground_truth_inputs` table. **\[OPEN-EXPLORATORY\]**, lean: keep them separate for clarity, they are read identically by the miner.

### 4.3 Raw layer \[LOCKED that append-only \+ provenance; exact sections OPEN-EXPLORATORY\]

One `raw_*` table per `db.json` section, all sharing the Miine raw shape (`id, capture_id, user_id, data jsonb, created_at`). Working set of sections:

| Raw table | Holds |
| :---- | :---- |
| `raw_people` | people mentioned |
| `raw_places_orgs` | places you go, orgs you are affiliated with |
| `raw_projects` | things you are working on (work and personal) |
| `raw_events` | dated happenings, past and upcoming |
| `raw_facts` | durable facts and preferences about you |
| `raw_relationships` | stated relationships between things |
| `raw_commitments` | things you said you would do, follow-ups owed |
| `raw_collection_mentions` | items that belong in a named collection (gift list, books, restaurants) |

Exact section set is **\[OPEN-EXPLORATORY\]**: emit `db.json` loosely, observe 5 to 10 real captures, then freeze. (Same call Miine made.)

### 4.4 Canonical layer, mapped to A → B → C \[LOCKED staging; columns partly OPEN-EXPLORATORY\]

Every canonical table carries the shared columns from §4.1 (provenance, temporal class, validity, confidence, salience). The staging is the Miine engine unchanged.

**Stage A (resolve first, everything references these):**

- `canonical_people` — name, resolved aliases, relationship, closeness, `work_or_personal` tag, optional contact handles, optional explicit `cadence` (follow-up interval). Class usually `evergreen`; specific facts about a person decay separately.  
- `canonical_places_orgs`.

**Stage B (self-contained, may run in parallel):**

- `canonical_projects` — status. Class `decaying` (active work ages and gets re-confirmed).  
- `canonical_events` — class `dated`, archives after the date.  
- `canonical_facts` — durable facts and preferences. Class mostly `evergreen`.  
- `collections` \+ `collection_items` — the hybrid extensible mechanism (§4.5).

**Stage C (cross-cutting, last):**

- `canonical_relationships` — edges between resolved nodes.  
- `canonical_commitments` — the actionable type the companion consumes. `status` (`open | scheduled | done | snoozed`), `due`, linked `person_id`, `work_or_personal`. Class `dated` or `decaying`.  
- `insights` — open-schema catch for cross-corpus patterns, so unanticipated findings have a home without a migration.

### 4.5 Hybrid collections \[LOCKED mechanism; auto-create aggressiveness OPEN-EXPLORATORY\]

A fixed core of canonical types (above) plus a flexible collections layer for ad-hoc lists.

```sql
create table collections (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  name        text not null,          -- 'gift list', 'books to read', 'restaurants to try'
  created_by  text not null,          -- 'user' | 'miner_proposed'
  created_at  timestamptz not null default now()
);
create table collection_items (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid not null references collections(id),
  user_id       uuid not null,
  data          jsonb not null,       -- the item; may reference a person_id / place_id
  source_claim_ids uuid[],
  created_at    timestamptz not null default now()
);
```

- Routing into collections happens three ways: the miner auto-routes from captures ("I should get mom a scarf" lands in the gift list), a capture-time `routing_hint` steers it, or you add an item by hand. (Both, per the decision.)  
- The interview agent can steer you into a collection category and index on it ("anything you want to pick up for people this month?").  
- **Closed-vocabulary guard to prevent context rot:** the miner does not silently spawn new collections. It proposes a new collection (`created_by = 'miner_proposed'`) and you accept it before it becomes real. Aggressiveness of this proposal is **\[OPEN-EXPLORATORY\]**, lean: propose only on a repeated pattern, never on a single mention.

### 4.6 Aux layer \[LOCKED\]

- `open_threads`, `discrepancies` (as in Miine, but discrepancies now feed supersession in §3).  
- Reconfirm candidates are a **computed view** over canonical (`temporality = 'decaying' AND confidence < t AND salience > s`) rather than a materialized table. **\[OPEN-EXPLORATORY\]** if it should be materialized for performance, lean: computed until it is slow.

---

## 5\. The miner \[LOCKED engine; personal schema per §4\]

Reuse from Miine, unchanged: A → B → C dependency ordering, one table per LLM call, recompute-from-raw, mandatory provenance, canonical history retention, output pagination, two-round verification.

New on top:

- **Ground-truth set on recompute is raw \+ corrections \+ confirmations**, not raw alone. This is the one structural change to the engine, and it is load-bearing for §3 and §4.2.  
- Per-node temporal classification, supersession and validity-interval maintenance, decay computation, salience scoring, collection routing.

Cadence \[LOCKED\]:

- **Nightly full recompute** (cron) over the whole ground-truth set. Matches the two-layer-memory pattern (synthesized memory on a daily cron).  
- **Lightweight immediate pass** on each new capture so it is queryable within a minute or two. Design of the immediate pass is **\[OPEN-EXPLORATORY\]**, lean: embed the new raw immediately for semantic recall (§10) plus an optional single-type fast extraction; full reconciliation waits for the nightly run.

---

## 6\. Capture surface \[LOCKED\]

The centerpiece. A prominent `+` opening three separate paths:

- **Add text** — a text input screen, writes a `text` capture.  
- **Add memo** — microphone capture via `MediaRecorder`, sent to STT, writes a `voice` capture with the transcript in `body` and audio in `audio_url`. One-way, no conversation.  
- **Start interview** — mints an ElevenLabs session (reused session and attempt model), writes an `interview` capture from the transcript.

Optional `routing_hint` tag on any capture (skip it and the miner decides). Frictionless by default.

**STT provider is \[OPEN-EXPLORATORY\]** (§15). Lean: ElevenLabs Scribe to keep the vendor surface to one provider you already run, with OpenAI Whisper API as the named alternative. Build the STT call behind a small interface so the provider is swappable. Note the deploy environment's network allowlist must include the chosen provider's domain.

Web and PWA first, with microphone access. Native iOS is V2+. A good capture UI on the phone web is the bar.

---

## 7\. Interview agent, personal and graph-aware \[LOCKED\]

- **Personal master prompt.** Carry over Miine's V3 ingest-first principles (suppress the probe ladder early, continuers and mirroring as the ingestion move-set, follow-the-rabbit as a sanctioned turn action). Tone shifts from structured employee extraction to a low-friction brain dump that does not feel like an interrogation.  
- **Graph-aware.** The agent reads the canonical layer so it asks informed questions ("last week the TMI deal was up in the air, where did it land?"). This is most of what makes it feel like a companion rather than a recorder, and it is the same briefing-injection mechanism Miine already uses (§9).  
- **Domain steering.** Light scaffolding across life domains (work, relationships, family, health, history, interests, routines, goals). Freeform follow-the-thread by default, steers toward a domain only when you stall or when the briefing injects a target.  
- Reuses the ElevenLabs agent, the session and attempt model, and `conversation_config_override` for per-session prompt composition. Token target and externalized phrasing library carry over from Miine.

Per Miine practice, template `.md` edits require regenerating and committing the `.generated.ts` files (runtime filesystem reads fail in Vercel serverless).

---

## 8\. Baseline trainer and search gate \[LOCKED concept; thresholds OPEN-EXPLORATORY\]

Solves the cold-start problem directly: a personal agent is useless empty, and people do not know what to share. The trainer seeds the root nodes so everything later branches from established context instead of from nothing.

- **What it is.** The interview agent run as a structured curriculum across the roundness of a life (the domains in §7), establishing baseline nodes before the system tries to branch from them.  
- **The gate.** The chat and search surface (§10) is locked until the baseline is met. Capture and interview are always available, because you have to build the corpus before you can query it. This coercion is the point: it gets context out of you.  
- **Gate on coverage plus minutes, not minutes alone.** A pure minutes floor is crude and gameable. Track which domains have enough canonical density, show a "roundness" map of what is still thin, and unlock when both a domain-breadth threshold and a minutes floor are met. Minutes is the backstop, graph completeness is the real signal, and the roundness map gives a visible reason to keep going.  
- **Thresholds are \[OPEN-EXPLORATORY\]** (§15). Lean: a 40-minute floor plus coverage of N of M domains, tuned on real use. (Todd floated 40 and 100.)

---

## 9\. Companion core \[LOCKED design\]

Lives side by side with the interview agent and is fed by the briefing agent. Mostly reuse.

- **What it reads.** Open commitments, due-dated nodes coming up, low-confidence high-salience nodes (the §3 reconfirm candidates), thin threads.  
- **Two surfaces.**  
  1. **In-interface prompts** — "have you done X?" style checks shown in the app.  
  2. **Injection into the next interview** — when a session spins up, the briefing agent composes open threads, due follow-ups, and reconfirm checks into the interview's system prompt via `conversation_config_override`. "Inject" is the operative word: it alters how the conversation goes by adding context, it does not script the conversation. This is the same mechanism Miine already runs, so it is close to free.  
- **Actions: draft and confirm only in V0, code-gated.** It surfaces a follow-up ("you said you would get the deck to Jake, it has been nine days") and drafts a Gmail message or Calendar invite via the connected MCP tools. You approve before anything sends. Autonomous send and scheduling is V1, once the cadence logic has earned trust. Per harness doctrine, this gate is in code, not a prompt instruction.  
- **Cadence model.** Explicit per-contact cadence overrides cadence inferred from what you say. The `work_or_personal` tag routes whether a drafted action uses your work email and calendar or just surfaces a reminder.

---

## 10\. Retrieval: getting the corpus back \[LOCKED\]

The efficiency fact: the miner already relationalized everything into canonical, so the query path reads that compact layer and never re-derives from raw.

- **Primary path, structured retrieval over canonical.** A small set of deterministic, narrowly-named tools the chat LLM calls: `get_person`, `find_commitments(status, due)`, `list_in_collection(name)`, `get_project`, `neighbors_of(node)`. The LLM is a thin composing stage that routes to tools and writes the answer, not the orchestrator. Cached system prompt. This is the harness doctrine and reuses Miine's "MCP serves canonical" idea directly.  
- **Secondary path, semantic recall over raw.** pgvector embeddings on raw captures and on canonical node summaries, for the fuzzy questions where structure does not help ("that thing I said about feeling burned out"). Supabase ships pgvector, no new infra. Embedding model is **\[OPEN-EXPLORATORY\]** (§15), lean: a small cheap embedding model called through the same SDK.  
- **Hierarchy for efficiency.** Retrieval returns the compact canonical summaries first (the `summary` columns the miner already writes), and expands to raw verbatim only when the question needs the exact moment.  
- **Validity-aware** per §3: prefer current facts, annotate aged ones.

This surface is what the baseline gate (§8) unlocks.

---

## 11\. Contact sheet \[LOCKED\]

- Reads `canonical_people` plus Stage A alias resolution. Surfaces a navigable contact list.  
- **Contact identification:** resolves aliases ("Todd", "Todd at Trident") to one person, and surfaces merge candidates when it is unsure (a correction confirms the merge, §4.2).  
- **`work_or_personal` tagging** per contact, which feeds the companion's action routing (§9).  
- **Provenance x-ray on every fact.** The drawer is already built in Miine. Tapping a fact to see "you said this on March 3 in a memo" is near-free and is what makes the corpus trustworthy enough to act on.

---

## 12\. Scope matrix

Reminder: V0 means it exists and works. V1 means it is polished and tuned. Build V0 surfaces, then stop.

### V0 — every feature functional, end to end

| Item | Priority | Doneness | Notes |
| :---- | :---- | :---- | :---- |
| Repo scaffold, CLIs (GitHub, Vercel, Supabase) installed and authed | P0 | Locked | Own repo (created), own projects, separate creds |
| Single-user auth (Supabase Auth, just Todd) | P0 | Locked | Security-sensitive, not a public app |
| `captures`, `corrections`, `confirmations` \+ full canonical schema with temporal/validity/salience columns \+ RLS | P0 | Locked | Freshness primitives in schema from day one |
| Miner port: A→B→C, recompute from raw+corrections+confirmations, provenance, history, pagination | P0 | Locked | Engine reused; ground-truth set is the one engine change |
| Personal canonical schema (working set §4.4) | P0 | Locked | Exact columns Open-Exploratory |
| Nightly recompute cron \+ lightweight immediate pass | P0 | Locked | Immediate-pass design Open-Exploratory |
| Capture surface: `+` with text / voice memo (STT) / start interview | P0 | Locked | STT provider Open-Exploratory; STT behind an interface |
| Personal interview agent (ingest-first, graph-aware, domain-steered) | P0 | Locked | Reuses ElevenLabs \+ `conversation_config_override` |
| Baseline trainer \+ search gate (coverage \+ minutes, roundness map) | P0 | Locked | Thresholds Open-Exploratory |
| Contact sheet (people, alias resolution, work/personal tag, provenance drawer) | P0 | Locked |  |
| Retrieval: structured tools over canonical \+ pgvector over raw, validity-aware | P0 | Locked | Embedding model Open-Exploratory |
| Companion core: briefing injection \+ in-interface prompts \+ draft-and-confirm actions (Gmail/Calendar MCP) | P0 | Locked | Autonomous send is V1; action gate in code |
| Freshness loop: validity/supersession \+ decay \+ salience \+ re-confirm surfacing | P0 | Locked | Constants Open-Exploratory; the §3 novel core |
| Hybrid collections (registry \+ items \+ routing \+ propose-new guard) | P1 | Locked | Gift list works; auto-create aggressiveness Open-Exploratory |
| Capture-time `routing_hint` tag | P1 | Locked |  |
| Telemetry (tool calls, miner runs, cache hit rate) | P0 | Locked | Harness doctrine, day one |

### V1 — pretty and tuned

| Item | Priority | Notes |
| :---- | :---- | :---- |
| Visual polish across all surfaces | P0 | The "make it pretty" pass |
| Autonomous action send/scheduling | P1 | Graduate from draft-and-confirm once trusted |
| Proactive push / notification initiation | P1 | Companion reaches out outside the app |
| Knowledge-graph visualization (dagre) ported and refined | P1 | Reuse Miine viz |
| Decay half-lives, salience, gate thresholds tuned from real use | P0 | The constants left open in V0 |
| Interview/companion phrasing-variety library | P2 | Reuse Miine pattern |

### V2+ — captured, not designed

- Native iOS app.  
- Multi-user, if it ever becomes a product (reactivates the preserved tenancy layer).  
- Cross-surface presence (Slack, email), the Sauna-shaped direction.  
- Re-mining / model-upgrade reprocessing loop.

---

## 13\. Infrastructure and build environment \[LOCKED\]

- New repo (created), own Supabase project, own Vercel project, separate credentials. No path for this project's Claude Code to touch Miine's canonical Supabase project.  
- **Project structure:** a single Next.js App Router app plus a copied `packages/miner-core`. A full Miine-style monorepo is unnecessary for a single-user app, but copying `miner-core` as a package keeps the engine cleanly separated. **\[OPEN-EXPLORATORY\]** if a thin workspace is preferred, lean: single app \+ one package.  
- **CLI trifecta \+ Claude Code:** GitHub CLI, Vercel CLI, Supabase CLI installed and authed before any git or DB work. Claude Code drives PRs, deploys, and migrations.  
- **Standing rules carried from CLAUDE.md:** RLS on every table, service role server-side only, JWT validation on every authenticated route, principle of least privilege, decision log appended to CLAUDE.md after every substantive decision, no em dashes in written documents, template `.md` edits require regenerating and committing `.generated.ts`.

---

## 14\. Invariants \[LOCKED\]

1. `captures`, `corrections`, `confirmations` are append-only. Every raw row carries `capture_id`.  
2. Every canonical row carries `source_claim_ids` tracing to raw rows.  
3. The canonical layer is recomputed from the full ground-truth set (raw \+ corrections \+ confirmations) each run, never from prior canonical output.  
4. Canonical is never edited directly. Fixes go through `corrections`, freshness goes through `confirmations`.  
5. Derivation is dependency-ordered A → B → C and emits one table per LLM call.  
6. Canonical history is retained so any prior state is reconstructable.  
7. Every canonical row carries a temporal class plus validity interval. Retrieval is validity-aware.  
8. High-stakes actions (send, schedule) are gated in code, not in a prompt.

---

## 15\. Open decisions

| \# | Item | Doneness | Recommendation |
| :---- | :---- | :---- | :---- |
| 1 | STT provider | OPEN-EXPLORATORY | ElevenLabs Scribe (single vendor) vs OpenAI Whisper API. Lean Scribe; build behind a swappable interface; ensure the deploy network allowlist covers the provider. |
| 2 | Embedding model for pgvector | OPEN-EXPLORATORY | A small cheap embedding model via the same SDK. |
| 3 | Exact `db.json` sections and canonical columns | OPEN-EXPLORATORY | Emit loose, observe 5 to 10 real captures, freeze. (Miine's own approach.) |
| 4 | Baseline gate thresholds | OPEN-EXPLORATORY | 40-minute floor \+ coverage of N of M domains; tune on real use. |
| 5 | Decay half-lives and salience thresholds | OPEN-EXPLORATORY | Start conservative, tune in V1. |
| 6 | Collection auto-create aggressiveness | OPEN-EXPLORATORY | Propose-and-confirm only on a repeated pattern, never a single mention. |
| 7 | Immediate-pass design (freshness before nightly) | OPEN-EXPLORATORY | Embed new raw immediately for semantic recall \+ optional single-type fast extraction; full reconciliation nightly. |
| 8 | `corrections` and `confirmations` separate vs unified | OPEN-EXPLORATORY | Keep separate for clarity; read identically by the miner. |
| 9 | Reconfirm candidates computed vs materialized | OPEN-EXPLORATORY | Computed view until it is slow. |
| 10 | Project structure (single app vs thin workspace) | OPEN-EXPLORATORY | Single Next app \+ copied `miner-core` package. |

**No OPEN-BLOCKING items.** Given the decisions made in conversation, nothing hard-blocks the start of the V0 build. The items above are choices better made against real captures than guessed, each with a recommendation. Resolve them as they come up rather than up front.

---

## 16\. Build sequence (MVP-first, exists then pretty)

Staged PRs. Build in order. Do not jump ahead. The freshness schema primitives land in PR0 because they are load-bearing; the active freshness loop is wired in PR8 because it rides the companion and briefing surface.

0. **Foundation.** Repo scaffold, CLIs authed, Supabase project, single-user auth. `captures` \+ `corrections` \+ `confirmations` \+ full canonical schema with temporal/validity/salience columns \+ RLS. Telemetry sink.  
1. **Miner port.** A → B → C against the personal schema, recompute from the full ground-truth set, provenance, history, pagination, nightly cron \+ immediate pass. Validate Stage A (people/places resolution) against one real captured session before going further. Stage A correctness gates everything downstream.  
2. **Capture surface.** The `+` with all three modes. STT behind an interface.  
3. **Personal interview agent.** Ingest-first graph-aware prompt, domain steering, session minting via `conversation_config_override`.  
4. **Baseline trainer \+ search gate.** Curriculum, coverage \+ minutes gate, roundness map.  
5. **Contact sheet.** People, alias resolution, work/personal tag, provenance drawer.  
6. **Retrieval \+ chat.** Structured tools \+ pgvector, validity-aware, gated by the baseline.  
7. **Companion core.** Briefing injection, in-interface prompts, draft-and-confirm via Gmail/Calendar MCP, cadence model.  
8. **Active freshness loop.** Supersession and validity maintenance in the miner, decay and salience scoring, reconfirm surfacing through the companion and briefing, retrieval validity-awareness end to end.  
9. **V1 polish.** Make it pretty, port the dagre graph, tune the open constants, autonomous actions, push.

---

## 17\. Resolved-decisions log

- **Exists-then-pretty version cut.** V0 is every feature functional, V1 is polish and tuning. Replaces an earlier proposal to defer the companion core. Nothing is dropped. Discipline moves to per-feature minimum surface.  
- **Three separate capture modes** with a prominent `+`. Memo is one-way STT, interview is conversational ElevenLabs, text is typed. Frictionless capture is the north star.  
- **Clean separate repo over a never-merge branch.** Miine is a real business with other people and reference accounts; the personal corpus and experiments get their own world. Repo created.  
- **Backend follows the harness pattern** from the Agent\_Harnesses notes: LLM as a pipeline stage, deterministic routing, code-gated actions, cached prompts, telemetry day one, direct SDK.  
- **Hybrid extensible collections.** Fixed core canonical types plus a flexible collections layer, navigable, with a propose-and-confirm guard against sprawl. The interview agent steers into categories.  
- **Baseline trainer with a coverage-plus-minutes gate.** Solves cold start by seeding root nodes; locks the search surface until the corpus is built. Improvement over a pure minutes floor.  
- **Companion core via briefing injection.** Reuses Miine's briefing mechanism; "inject" open threads and reconfirm checks into the next interview's prompt. Two surfaces: in-interface and injected. Actions are draft-and-confirm in V0.  
- **Retrieval is structured-first over canonical, semantic-second over raw,** hierarchical and validity-aware, with a thin composing LLM stage.  
- **Self-refreshing corpus** (§3): validity intervals and supersession, decay by temporal class, re-confirmation through the conversation loop, salience gating. The builder is the maintainer. Corrections fix errors, confirmations fix staleness, both are append-only miner inputs.  
- **Temporal class is mandatory** on every canonical node.

*End of spec. Build only \[LOCKED\] items. Surface \[OPEN-EXPLORATORY\] recommendations to Todd. There are no \[OPEN-BLOCKING\] items; proceed with the V0 build.*  
