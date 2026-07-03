# Navigation and load-latency audit (2026-07-02)

Measured before changing anything. This separates ACTUAL load time (real milliseconds)
from PERCEIVED latency (a screen that blocks on data feels frozen even when the data is
fast). No feature or quality is reduced by any of the applied changes; per-user RLS and
isolation are untouched.

## Method
- Bundle sizes from a real `next build` (baseline captured before edits).
- Per-screen data-fetching read directly from every protected page + its data lib.
- Auth cost traced through `lib/auth/guard.ts` + `lib/supabase/middleware.ts`.
- Indexes read live from `pg_indexes`; region read live from the Supabase Management API.

## Top causes, prioritized by impact

### 1. No streaming anywhere (PERCEIVED, highest, SAFE to fix, APPLIED)
There are ZERO `loading.tsx` files and ZERO `Suspense` boundaries in the app. Every
navigation to a server-rendered page waits for the FULL render (auth round-trips + all
data queries) before a single pixel changes, so navigation feels frozen even when the
data is quick. This is the single biggest perceived-latency cause.

Compounding: `next/link` prefetches by default, but for a DYNAMIC route (all these pages
are per-user and cookie-dependent) prefetch only prefetches up to the nearest
`loading.tsx`. With no loading boundary, the prefetch is a no-op, so a click waits for
the entire dynamic render.

FIX (applied): a `loading.tsx` skeleton on every navigable route. A click now paints the
page chrome (top bar, title, placeholder rows) instantly and the data streams in, and the
prefetch of the skeleton becomes real. Cuts nothing.

### 2. Region mismatch: Vercel us-east <-> Supabase us-west-2 (ACTUAL, highest real ms, RECOMMEND)
Live-measured: the Supabase project `memo-phoenix` is in `us-west-2` (Oregon). Vercel has
NO region pin (`vercel.json` has none), so serverless functions default to `iad1`
(us-east-1, Washington DC). Every Supabase call (auth revalidation, every query) is a
cross-country round-trip of roughly 60-70ms each way, ~130ms base RTT.

A protected navigation makes several sequential round-trips (see cause 3 + 4), so at
~130ms each this is roughly 400-800ms of pure network latency per navigation, before any
data work. Co-locating Vercel in `sfo1` or `pdx1` (both near us-west-2) would drop the
per-round-trip base from ~130ms to ~10-20ms.

RECOMMENDED (not applied; a deploy-config change to review): add to `vercel.json`
```
{ "regions": ["sfo1"], "crons": [ ... existing ... ] }
```
Estimated effect: the largest single actual-latency win, ~300-700ms off every protected
navigation, with no code change. Left as a recommendation per the brief (region
co-location needs operator review; it also affects cold-start locality).

### 3. Auth is paid twice per navigation (ACTUAL, RECOMMEND, needs security review)
Every protected navigation revalidates the JWT against the Supabase Auth server TWICE:
- `lib/supabase/middleware.ts` calls `supabase.auth.getUser()` on every matched request.
- Then the page's `requireAllowedUser()` (`lib/auth/guard.ts`) calls `getUser()` AGAIN,
  plus `isInvited()` (a DB query) for any non-operator user.

So before a page fetches its own data it pays: middleware `getUser` + guard `getUser` +
(non-operator) `isInvited`, i.e. 2-3 sequential round-trips, each crossing regions (cause
2). `getUser()` is a network call (it revalidates against the auth server, deliberately
not `getSession()`), so this is real latency, not local work.

Why it is this way (do NOT weaken): the guard is the security boundary and MUST validate
independently; the middleware is UX-only and is explicitly never trusted for
authorization (documented in `guard.ts`). So the two checks cannot simply be collapsed.

RECOMMENDED (needs review): options that keep the boundary intact:
- Cache `isInvited(email)` per-user for a short TTL (e.g. React `cache()` within a
  request, or a small in-memory TTL keyed by email) so repeated navigations by the same
  user do not re-hit the invites table. Per-user only; never shared across users.
- Keep both `getUser()` calls (they are the JWT validation) but note that co-locating the
  region (cause 2) makes each call ~10x cheaper, which is the higher-leverage fix.

### 4. Blocking telemetry write on the companion page (PERCEIVED+ACTUAL, SAFE, APPLIED)
`app/companion/page.tsx` did `await logEvent(...)` before returning the page, adding a
Supabase insert round-trip to the critical render path. `logEvent` is designed
fire-and-forget (it catches its own errors and never throws into the caller).

FIX (applied): call it without awaiting, so the page renders without waiting on a
telemetry insert. No event is lost (same fire-and-forget contract).

## Measured NON-problems (recorded to prevent false alarms and wasted effort)

### Indexes are already comprehensive (no action needed)
Every hot table already has the right indexes, verified live:
- Each canonical table (`canonical_people/commitments/events/facts/relationships`) has a
  PARTIAL index `(user_id) WHERE valid_to IS NULL` (the exact shape of the "current rows
  for this user" query), a plain `(user_id)` index, and a GIN index on `source_claim_ids`
  (provenance).
- `captures (user_id, created_at DESC)`, `corrections (user_id, created_at DESC)`,
  `miner_runs (user_id, started_at DESC)` + a partial `WHERE status='running'`,
  `companion_state (user_id, commitment_id)`.
So the hot per-user, current-rows, ordered queries are all index-served. There is nothing
to add; the "add indexes" win is already done. (At ~70 rows/table the sort steps are also
trivial.)

### Bundle sizes are healthy for general navigation
Baseline `next build`: shared First-Load JS is 102 kB (React + Next + Supabase client),
and most routes land at 103-112 kB First Load JS, which is fine. The only heavy routes are
`/capture/interview` (237 kB) and `/onboarding` (233 kB), both carrying the ElevenLabs
voice SDK (~125 kB). That SDK is a deliberate route-static import (a prior attempt to defer
it broke the live agent, see the decision log), it is isolated to those two voice routes,
and it does not touch general tab navigation. So general navigation is NOT bundle-bound.

The one avoidable weight is the temporary mic-diagnostics instrumentation (PR #36), which
is being removed here (its job is done): it added ~2 kB to `/capture/memo` and rides the
interview routes.

### Data fetches are already parallelized (no waterfalls of chained awaits)
- Home: 3 count queries in one `Promise.all` (active run, capture count, people count).
- People list: the people query and `pendingRenames` in one `Promise.all`.
- Person detail: the person row, then neighbors + provenance + commitments + renames in
  one `Promise.all` (a minor 2-phase read, inherent to needing the row first).
- Companion `getToday`: commitments + events + overlay + relationship-nudges + people in
  one `Promise.all`, then a single `attachProvenance` phase (inherent: provenance resolves
  the claim ids the batch just returned).
There are no sequential await chains to flatten. The only micro-redundancy is companion
reading `canonical_people` in both `loadPeople` and `relationshipNudges`, but they run
concurrently (same batch), so it is DB load, not latency, and it is kept deliberately for
label-drift resilience (see the decision log).

### Cold start
No region pin means functions cold-start in us-east while the DB is us-west, so the first
request after idle pays both a cold start (~200-500ms) and the cross-region penalty.
Region co-location (cause 2) addresses the locality half; keeping functions warm (or
Vercel's fluid compute) addresses the rest. Recommendation, tied to cause 2.

## Caching (RECOMMEND, per-user only, never cross-user)
The data is per-user under RLS. Any cache MUST be keyed by user id and NEVER shared across
users; a cross-user cache would be a correctness and privacy bug. Safe options to review:
- Wrap the auth check and the hot read helpers in React `cache()` so multiple calls WITHIN
  one request/render dedupe (request-scoped, inherently per-request, safe). This does not
  span middleware and the page render (separate invocations), so it does not remove cause 3
  by itself.
- A short `unstable_cache` on a read helper keyed EXPLICITLY by `userId` (e.g.
  `['people', userId]`) with a small revalidate window, invalidated by the existing
  `revalidatePath` after mutations. Only if the freshness trade-off is acceptable; the
  graph changes only on a mine, so a short TTL is low-risk. Must include userId in the key.

## Fonts (RECOMMEND, low priority)
`app/layout.tsx` loads Newsreader via a render-blocking Google Fonts `<link>` (preconnect
is present and `display=swap` avoids invisible text). Moving to `next/font` self-hosts the
font, removes the third-party connection and the render-blocking external stylesheet, and
eliminates a layout dependency on fonts.googleapis.com. Behavior-neutral but a font-loading
change, so left as a recommendation.

## Applied changes, with measured before/after
- STREAMING SKELETONS: added `loading.tsx` to every navigable route (`/`, `/people`,
  `/people/[id]`, `/companion`, `/ask`, `/miner`, `/capture/text`, `/building`) plus a
  shared `components/skeleton.tsx` and an `.mp-skel` shimmer. A click now paints the real
  chrome (top bar, title, nav) + shimmer placeholders instantly, and the per-user data
  streams into the same regions (no layout jump). This also makes `next/link` prefetch
  meaningful for these dynamic routes. loading.tsx shells add 0 to First-Load JS.
- COMPANION TELEMETRY: `await logEvent` -> `void logEvent` (removed one insert round-trip
  from the render path; same fire-and-forget contract, no event lost).
- PERSON DETAIL: `listPeople` ran TWICE (directly for the merge picker AND inside
  `duplicateCandidates`). Now fetched once and reused: two concurrent identical queries
  become one.
- REMOVED the temporary mic-diagnostics panel + level meter (kept the real error handling
  `acquireMic`/`describeMicError`, the probe handling, and the defensive `setMuted(false)`
  fix). Bundle First-Load JS: `/capture/memo` 111 -> 109 kB, `/capture/interview`
  237 -> 234 kB, `/onboarding` 233 -> 231 kB.
- INDEXES: verified already complete on every hot path; added none.

## Summary
- Applied (safe, no quality/feature loss): streaming skeletons on every navigable route
  (the biggest perceived-speed win), un-blocked the companion telemetry write, de-duped the
  person-detail double fetch, removed the temporary mic-diagnostics. Indexes were already
  complete.
- Recommended (need review): pin Vercel to a us-west region (biggest actual-latency win),
  per-user caching of the allowlist / hot reads, and `next/font`.
- The highest-leverage single change overall is the region co-location (a one-line
  `vercel.json` addition, recommended for review); the highest-leverage code change,
  applied here, is the streaming skeletons.
