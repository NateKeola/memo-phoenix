# Spec: Memo Phoenix Buildout (post-V0)

> **Reading instructions for the implementing agent:**
> This document tags every decision with a doneness state.
> - **Locked** items are constraints. Implement them as written.
> - **Open-Blocking** items must be resolved with the human before any code is written that depends on them. Ask, do not assume.
> - **Open-Exploratory** items want 2 to 4 proposed options surfaced for the human to pick from. Do not pick one yourself.
> - If an item has no tag, treat it as Open-Blocking and ask before building.
> Do not treat unmarked structure (headers, bullets, prose) as a license to expand scope beyond tagged items. Each build unit below is its own Claude Code prompt; build one unit at a time, branch and PR per unit, do not merge yourself.

**Goal:** Finish the work that turns the secured multi-user beta into something polished and pleasant to use: a real onboarding voice, a way to see and control the miner, and a fast, good-looking, mobile-first interface.

**Where this picks up:** The full V0 is built and on main. B1 (security gate) and B2 (invite-only beta: admin-minted invites, onboarding interview with a placeholder bible, off-machine miner runtime on the Pro route with an Actions fallback, `invites` and `miner_runs` tables) are built. Public signups are disabled. The RLS and multi-user guards (`check-rls.mjs`, `check-multiuser.mjs`, `check-invite.mjs`) must stay green through everything below.

**Out of scope (this spec does not cover):** local-first text capture (deprioritized by Todd), email/calendar sending, connectors UI, SSO, roles/teams/orgs, billing. New product features generally. The backlog at the end captures deferred infrastructure; it is not part of these three units.

---

## Build Unit 1 — Onboarding intro bible (swap placeholder for authored)

One-line outcome: the onboarding interview speaks in the real authored first-time voice, not the placeholder.

| Item | Priority | Doneness | Notes |
|------|----------|----------|-------|
| Replace `prompts/onboarding-bible.md` with the authored bible (provided alongside this spec) | P0 | Locked | Drop the file, run the existing `bible:generate` (or equivalent) so the `.generated.ts` ships in the bundle. The placeholder from B2 is the thing being replaced. |
| Confirm the onboarding interview uses the new bible and seeds the new user's graph | P0 | Locked | No behavior change beyond the voice; the B2 onboarding flow and capture path stay as built. |

Note: this unit is small enough that it can be done by hand (drop the authored file, regenerate, commit) without a full Claude Code build. Listed here for completeness and so the swap is not forgotten.

---

## Build Unit 2 — Miner-control UI

One-line outcome: the user can see the miner's history and trigger it, and it runs itself when enough new context has piled up.

Builds on the B2 runtime: the `/api/miner/run` route, the `miner_runs` table, the Actions fallback, and the concurrency guard already exist. This unit is the surface over them, not new plumbing.

| Item | Priority | Doneness | Notes |
|------|----------|----------|-------|
| A miner-control surface in the app | P0 | Locked | A place the user can see miner state and act on it. Exact location in the app is Open-Exploratory (see below). |
| Manual "run now" trigger | P0 | Locked | Calls the existing `/api/miner/run` for the signed-in user; honors the concurrency guard (a run already in progress is a no-op with clear feedback). |
| Live status while a run is in progress | P0 | Locked | Reuse the B2 `/building` polling/status pattern; show "building your memory" style progress. |
| Run ledger | P0 | Locked | Reads `miner_runs`: each run with timestamp, trigger source (manual vs auto), and what changed (the inserted/updated/unchanged counts the miner already reports). Newest first. |
| Progress-toward-auto-run indicator | P1 | Locked | A simple bar or count showing how much new unmined context has accumulated since the last run, building toward the auto-run threshold. |
| Auto-run when accumulated new context crosses a threshold | P1 | Open-Exploratory | The mechanism (auto-trigger a mine when the measure crosses a line) is the intent; the measure and value are not decided. See open items. |
| Exact placement of the surface | P1 | Open-Exploratory | Settings area vs a dedicated miner tab vs a home-screen widget. Propose options. |

Out of scope for this unit: making the miner fast (the incremental pass is backlog), local-first, any change to how the miner derives the graph.

---

## Build Unit 3 — V1 design and performance/mobile pass

One-line outcome: the whole app is fast, fluid, mobile-first, and visually intentional, with no behavior change.

This is a restyle-and-optimize sweep over the existing surfaces (capture, interview, onboarding, building, chat/ask, contacts, today/follow-ups, admin), not new features. Best done as its own large prompt after the feature set is stable, which it now is. Strongly consider doing the visual exploration in Claude Design.

| Item | Priority | Doneness | Notes |
|------|----------|----------|-------|
| Performance and lightness | P0 | Locked | Fast and fluid. Prefer plain HTML/CSS; avoid heavy frontend frameworks unless a specific complex animation genuinely needs one. Responsiveness and snappiness are the bar. |
| Mobile-first / mobile optimization | P0 | Locked | The app is used on phones (the beta users will be on mobile). Mobile is the primary target, not an afterthought. |
| No purple, anywhere | P0 | Locked | Hard constraint. |
| Warm cream + muted mustard/ochre as the palette base | P0 | Locked | The placeholder direction becomes the real base. |
| The actual visual design system (type, spacing, components, motion) | P0 | Open-Exploratory | Propose 2 to 4 directions (ideally in Claude Design) for Todd to pick. Do not pick one and build it unilaterally. |
| No behavior or data change | P0 | Locked | This pass restyles and optimizes; it must not alter what surfaces do, and the RLS/multi-user guards must stay green. |
| Every main surface gets the pass | P1 | Locked | Consistency across capture, interview, onboarding, building, chat, contacts, today, admin. |

Out of scope for this unit: any new feature, any new data, any change to the miner or graph.

---

## Recommended build order

1. **Unit 1** first, basically free. Drop the authored bible and regenerate; do it alongside the live invite test so a new user's first conversation already has the real voice.
2. **Unit 2** next. It builds on plumbing that already exists, it is immediately useful (you stop running the miner blind), and it is a contained, low-risk build.
3. **Unit 3** last of the three, as its own large prompt. It is the highest-impact single thing, and it is best done now that the feature set is stable so you are not restyling surfaces that are still changing.

Pull two backlog items forward around Unit 3 if appetite allows, because multi-user raised their urgency: the deterministic-id hardening (more users means more name drift and merges) and the incremental miner pass (it directly shortens the new-user wait and cuts cost at 5x the mining). The id hardening in particular is the highest-leverage debt and ideally lands before your beta users accumulate weeks of data.

---

## Backlog (V2+, captured, not designed)

- **Deterministic-id hardening.** The name-keyed id has caused four symptoms (churn, people-merge, companion overlay, freshness). Highest-leverage debt; recommend before heavy user data.
- **Incremental miner pass.** Fixes the ~9-minute full recompute; shortens new-user wait and cuts multi-user cost.
- **Per-stage model-routing harness + cost AB test.** Default Opus, drop cheaper models into mechanical stages, AB-test by diffing canonical output on the same captures.
- **Semantic / pgvector search.** The fuzzy-recall path deferred from the search build.
- **Photo reminisce feature.** The Apple "remember this" style memory capture; another "add context" surface.
- **Local-first text capture.** Deprioritized by Todd; parked.
- **Email/calendar sending, connectors UI, SSO.** Parked from the companion pivot.

---

## Open items needing resolution

**Blocking (must resolve before the relevant unit builds):**
- None. All three units can start; their P0 Locked rows are buildable as written.

**Exploratory (agent proposes options, Todd picks):**
1. Miner auto-run threshold (Unit 2). What measure triggers an auto-run (count of new captures, count of new raw rows, time since last run, or a combination) and what value. Propose a couple of simple, transparent options.
2. Miner-control surface placement (Unit 2). Settings vs dedicated tab vs home widget.
3. The V1 design direction (Unit 3). 2 to 4 visual directions within the cream/ochre, no-purple, lightweight constraints, ideally explored in Claude Design.
