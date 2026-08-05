# Memo V1 Specification: Personal + Enterprise, iOS, Observability

Status: draft for Todd's review. Nothing in here is built.
Supersedes: the Memo Enterprise context doc (`01-memo-enterprise.md`) for items EM-1, EM-4, EM-5, EM-7. EM-2 and EM-3 are out of scope and remain as written there.

> **Reading instructions for the implementing agent:**
> This document tags every decision with a doneness state.
> - **Locked** items are constraints. Implement them exactly as written.
> - **Open-Blocking** items must be resolved with the human before any code is written that depends on them. Ask, do not assume.
> - **Open-Exploratory** items want 2 to 4 options surfaced for the human to pick from. Do not pick one yourself.
> - If an item has no tag, treat it as Open-Blocking and ask before building.
> Do not treat unmarked structure (headers, bullets, prose) as license to expand scope beyond tagged items. One PR per phase. A human merges. Agents never merge.

---

## 0. Goal and non-goals

**Goal.** Memo runs as two products on one codebase: Memo Personal (private, single user) and Memo Enterprise (team-scoped, shared). A user toggles between them. An iOS client in native Swift becomes the primary consumption surface. Every run, cost and client action is visible in an admin-only console.

**Out of scope for V1.**
- EM-2 autonomous build-detection agent (scanner, ranker, initiator).
- EM-3 point-at-a-folder autonomy.
- Nightly batch miner mode. Explicitly cut by the operator in favour of demand-driven mining (see section 4).
- The social / correlation layer.
- Any change to miner internals other than MT-7. The miner is treated as a black box that accepts a scope and produces a graph.
- Workspace billing, SSO, SCIM, audit export.

---

## 1. Assumptions carried in

These are stated so they can be corrected in one line rather than discovered mid-build.

| ID | Assumption | If wrong |
|---|---|---|
| A-1 | Native Swift is confirmed over Expo. The conversation layer gets written fresh rather than ported. | Whole of section 6 changes. |
| A-2 | Claude Code runs on a Mac with Xcode installed and may invoke `xcodebuild` for compile checks only. | Phase 6 to 8 acceptance model changes. |
| A-3 | PR #46 is merged. Miner token fix and run-mode recording are live. | Phase 4 cost numbers are wrong. |
| A-4 | No enterprise customer has a dated commitment. Workspaces ship behind a flag with Todd's own workspace as tenant zero. | Phase order changes, workspaces move ahead of iOS. |
| A-5 | Existing beta users (Todd, toddrdgavin, nprestine) stay on web through the transition and nothing they hold needs migrating beyond an additive backfill. | Phase 1 needs a data plan. |

---

## 2. Invariants

Carried forward unchanged from Memo Phoenix. **[Locked]**

1. The miner is the only writer of the canonical graph. The app never writes canonical directly.
2. Provenance is mandatory. Every raw row carries `capture_id`, every canonical row carries `source_claim_ids`.
3. Soft delete only. Service-role key is server-side only.
4. Invite-only auth. No public signup. Observability console is admin-only.
5. Branch off main, PR, human merges. Every PR updates `docs/HANDOFF.md` and appends a dated entry to `CLAUDE.md`.
6. No em dashes.

New, and they gate every change in this spec. **[Locked]**

7. **Authorization is by scope membership, not by user id.** After Phase 1, `user_id = auth.uid()` is not an authorization predicate anywhere. It survives only as authorship metadata on raw rows.
8. **Data never flows from a personal scope into a workspace scope.** No feature, no admin action, no export. This is a one-way wall.
9. **Data flows from a workspace scope into a personal scope only through an explicit user action that creates a new personal capture.** Never by copying canonical rows.
10. **Every write names its scope explicitly.** No server-side or session-side notion of a "current scope" is permitted on a write path.
11. **Observability never logs user content.** Event payloads carry ids, counts, durations and costs. Never text.

---

## 3. Scope model

This is the load-bearing decision. Everything downstream follows from it.

### SC-1. Scope at capture time, not ACL at node time **[Locked] [V0] [P0]**

Every capture carries a `scope_id`. The miner runs per scope and produces a graph per scope. A workspace graph is built only from captures explicitly directed at that workspace.

Rationale, and why the alternative was rejected: a canonical node derives from `source_claim_ids` belonging to several users with different visibility. Any node-level ACL resolves to either the intersection of contributor visibility (which makes shared nodes invisible to everyone) or the union (which is a leak). Capture-time scoping removes the question. There is no per-node ACL in Memo, now or later.

Consequence to accept: the same person exists as two unrelated entities across your personal graph and your workspace graph. Cross-scope entity linking is V2 and is an overlay, never a merge.

### SC-2. Schema **[Locked] [V0] [P0]**

```sql
create table scopes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('personal','workspace')),
  name text not null,
  created_by uuid not null references auth.users(id),
  allow_promotion_to_personal boolean not null default true,
  daily_cost_ceiling_usd numeric(10,2) not null default 2.00,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table scope_members (
  scope_id uuid not null references scopes(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (scope_id, user_id)
);

create unique index one_personal_scope_per_user
  on scopes (created_by) where kind = 'personal' and deleted_at is null;
```

Every table that today carries `user_id` as its authorization key gains `scope_id uuid not null references scopes(id)`. That covers captures, all raw tables, all canonical tables, corrections, overlays, entity_aliases, miner_runs and events. `user_id` stays on captures and raw rows as authorship. It is removed from no table. It authorizes nothing after Phase 1.

Workspace default ceiling is 10.00, set at creation, not by column default.

### SC-3. Migration **[Locked] [V0] [P0]**

Additive only, in this order, in one PR, behind flag `SCOPES_ENABLED` default off.

1. Create `scopes` and `scope_members`.
2. Backfill: one personal scope per existing user, `name = 'Personal'`, `created_by = user_id`, plus the matching owner membership row.
3. Add `scope_id` nullable to every affected table.
4. Backfill `scope_id` from `user_id` via the personal scope map.
5. Set `scope_id not null`. Add index on `(scope_id)` for every table, and `(scope_id, created_at desc)` where the table is read in time order.
6. Add new RLS policies alongside the existing ones, named `*_scope_v2`, reading:
   `scope_id in (select scope_id from scope_members where user_id = auth.uid() and deleted_at is null)`
7. Do not drop the old policies in this PR. They are dropped in Phase 2 only after the security harness passes on the new ones.

New user signup creates the personal scope in the server-side onboarding path, not in a database trigger. One creation path only.

### SC-4. Security harness extension **[Locked] [V0] [P0]**

`npm run security` grows from 8 surfaces to 11. The three new ones, all of which must pass before `SCOPES_ENABLED` flips:

- **S9 Scope isolation.** User A, a member of workspace W, cannot read any row of user B's personal scope, across every table, storage path, and API route.
- **S10 The one-way wall.** No API route, no RPC, no view, no storage path accepts a write whose target scope is a workspace and whose source is a personal-scope row. Asserted by attempting it and expecting rejection, not by code review.
- **S11 Membership revocation.** Removing a member from a workspace immediately removes read access, including to already-signed storage URLs issued before revocation, within the signed-URL TTL. Set that TTL to 300 seconds.

### SC-5. Promotion, workspace to personal **[Locked] [V0] [P1]**

The only bridge between scopes. Direction is workspace to personal only.

Flow: user viewing a workspace canonical node taps "Save to my Memo". The API creates a **capture** in that user's personal scope, of `source = 'promotion'`, whose text payload is a rendering of the node, carrying `origin_scope_id` and `origin_canonical_id` as metadata. The personal miner resolves it on the next run like any other capture.

No canonical row is ever copied. Invariant 1 holds. If the workspace has `allow_promotion_to_personal = false`, the endpoint returns 403 and the client hides the action.

Emits `promotion.created` with both scope ids and the node id. Never the text.

**Risk to note, not to solve here:** promotion means an employee's personal graph accumulates company knowledge that survives their departure. That is a data processing agreement conversation, not an engineering one. The per-workspace boolean exists so the answer can be "off" for a customer who asks.

### SC-6. Scope switching **[Locked] [V0] [P0]**

Active scope is client state and is transmitted explicitly on every request as a `scope_id` parameter (query for reads, body for writes). There is no server session scope and no cookie scope.

Rationale: a session-stored current scope is exactly how a capture lands in the wrong graph after an iOS background and foreground cycle, or after a second tab. Given invariant 8, that failure is unrecoverable. Explicit beats implicit here even though it is more verbose at every call site.

---

## 4. Mining trigger policy

Replaces the nightly cron mode from EM-5, which the operator cut. The objective is fewer, better-timed, cost-capped runs.

### MT-1. Demand-driven with debounce **[Locked] [V0] [P0]**

`capture.finalized` upserts a row in `mine_intents` for that scope with `due_at = now() + 10 minutes`. Each subsequent capture in the same scope pushes `due_at` forward, up to a hard cap of 60 minutes from first intent. If unmined captures for the scope reach 5, `due_at` is set to `now()`.

Result: a burst of captures produces one mine, not five. A trickle still mines within the hour.

### MT-2. One active intent per scope **[Locked] [V0] [P0]**

```sql
create table mine_intents (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references scopes(id),
  state text not null check (state in ('pending','dispatched','running','done','failed')),
  due_at timestamptz not null,
  dirty boolean not null default false,
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index one_active_intent_per_scope
  on mine_intents (scope_id) where state in ('pending','dispatched','running');
```

Captures arriving during a run set `dirty = true`. On completion, if `dirty`, a fresh intent is created with a full debounce window rather than an immediate re-run.

### MT-3. Scheduler **[Locked] [V0] [P0]**

One Vercel cron at `*/5 * * * *` selects intents where `state = 'pending' and due_at <= now()`, checks the ceiling (MT-4), and dispatches the existing GitHub Action per scope. This is the only cron in the system.

Note: because every window is relative, the UTC and daylight saving question from EM-D7 does not arise. That decision is closed by this design, not answered.

### MT-4. Cost ceiling, defer rather than block **[Locked] [V0] [P0]**

Before dispatch, sum `usage_ledger.cost_usd` for the scope over the trailing 24 hours. If it is at or above `scopes.daily_cost_ceiling_usd`, do not dispatch. Leave the intent pending, set `due_at = now() + 1 hour`, and emit `mine.deferred_ceiling`. The mine happens later, it is never dropped.

Defaults: personal 2.00 per day, workspace 10.00 per day. Both editable per scope by an admin on web.

### MT-5. Dead-man alert **[Locked] [V0] [P1]**

If a scope holds unmined captures older than 24 hours, emit `mine.stalled` once per scope per day and surface it in the console. This is the whole of what the EM-4 spend floor was reaching for, at zero cost.

### MT-6. Spend floor **[Locked] Do not build.**

Neither a floor nor a per-hour target, in any form. If the topic returns, the answer is MT-4 plus MT-5.

### MT-7. Prompt caching on the miner prefix **[Locked] [V0] [P1]**

The single sanctioned change to miner internals this cycle: mark the stable system prefix of each miner call with `cache_control: {type: 'ephemeral'}`. Cached input is billed at roughly a tenth of fresh input, and the miner's prefix is identical across pages of the same pass. Nothing else inside the miner is touched.

### MT-8. Batch API **[V2, captured not designed]**

Halves token cost and suits deferred runs. Cut from V1 because it restructures the miner's call path from streaming to submit, poll, retrieve, and the miner is fixed this cycle. Revisit when the ledger shows what the overflow lane actually costs.

---

## 5. API v1 and observability

### API-1. One contract, two clients **[Locked] [V0] [P0]**

All writes and all mine dispatch go through `/api/v1/*`. Web and iOS consume the same routes. Reads may be served directly from Supabase by either client under the Phase 1 RLS policies.

Rationale: if Swift writes captures directly to Postgres there will be two write paths within a month, and invariant 1 dies quietly. Reads carry no such risk and skipping a hop matters on cellular.

Routes, minimum set:

```
POST   /api/v1/captures                 { scope_id, kind, text? , storage_path? }
POST   /api/v1/captures/upload-url      { scope_id, content_type } -> signed PUT url, 300s
POST   /api/v1/corrections              { scope_id, kind, payload }
POST   /api/v1/promotions               { origin_scope_id, origin_canonical_id }
POST   /api/v1/mine                     { scope_id }        // manual trigger, respects MT-2 and MT-4
GET    /api/v1/scopes                                        // scopes this user belongs to
POST   /api/v1/scopes                   { name }             // workspace only, web only
POST   /api/v1/scopes/:id/invites       { email }            // web only
POST   /api/v1/events                   { scope_id, name, props }  // client telemetry, allowlisted names
```

Every route validates that `auth.uid()` holds a live membership in the named scope, server side, before anything else. Every route emits one event.

The contract lives at `docs/api-v1.md` in the web repo and is copied verbatim into `memo-ios`. Changes to it are a PR in both.

### OB-1. Events **[Locked] [V0] [P0]**

The existing events table gains three columns: `scope_id uuid`, `client text check (client in ('web','ios','api','miner','cron'))`, and `request_id text`. Taxonomy stays a flat allowlisted string. Payloads carry ids, counts, durations, model names and costs. Never text, never audio, never secrets. Asserted by S8 in the harness, extended to cover the new client-submitted route.

`POST /api/v1/events` accepts only names present in a server-side allowlist and is rate limited to 60 per minute per user. A compromised client cannot write arbitrary rows.

### OB-2. Usage ledger **[Locked] [V0] [P0]**

```sql
create table usage_ledger (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references scopes(id),
  run_id uuid,
  surface text not null,          -- 'miner' | 'interview' | 'stt' | 'api'
  model text,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  voice_seconds integer,
  cost_usd numeric(10,4) not null,
  created_at timestamptz not null default now()
);
```

Cached and fresh input tokens are separate columns. The price gap between them is large enough that a single blended figure hides the only lever worth pulling. Rates live in one server-side constants file with an effective date, not scattered at call sites.

Every miner run, every interview session and every STT call writes exactly one row.

### OB-3. Console **[Locked] [V0] [P1]**

The admin-only console at `/admin/observability` gains, in this order of importance:

1. Scope filter and client filter on the event stream.
2. Cost by scope by day, with the ceiling drawn as a line.
3. Mine timeline per scope: intent created, debounce window, dispatch, run start, stage, complete, with mode (full or incremental).
4. Stalled scopes and ceiling deferrals as standing lists, not as buried events.

Admin remains an allowlist on `MEMO_ADMIN_EMAIL`. Console is web only, forever.

---

## 6. iOS, native Swift

### IOS-1. What ships on iOS **[Locked] [V0] [P0]**

Consumption is on every surface. Administration is web only.

On iOS: sign in, scope switch, capture (voice memo and interview), Today, Memory read, promotion action.
Web only, permanently: workspace creation, invites, membership management, cost ceilings, the observability console, the correction and dispute surfaces.

This resolves the parity question in the direction that costs the least: because the API is scope-parameterized, an iOS client that supports one scope supports both for free. The expensive part of Enterprise is the admin surface, and that never needs to be on a phone. There is no "iOS is personal only" fallback because the fallback is not cheaper than the full thing.

### IOS-2. Project shape **[Locked] [V0] [P0]**

- New repo `NateKeola/memo-ios`. Not a folder in the web repo.
- SwiftUI, minimum target iOS 17.0.
- SPM only: `supabase-swift`, `elevenlabs-swift-sdk`.
- One app, one bundle id, one App Store listing. Scope toggle lives inside. Two apps would mean two review cycles for every change.
- `docs/api-v1.md` copied in, plus a `Contract.swift` of Codable types matching it exactly.

### IOS-3. Auth **[Locked] [V0] [P0]**

`supabase-swift`, email and password, session in Keychain, allowlist enforced server side. No Sign in with Apple requirement arises because no third-party social login is offered. No signup screen on iOS in V0. Users are created on web and sign in on device.

### IOS-4. Audio session **[Locked] [V0] [P0]**

The single largest source of bad reviews for voice apps, so it is scheduled rather than discovered. Phase 6 is a spike that does nothing but this.

- `AVAudioSession` category `.playAndRecord`, mode `.voiceChat`, options `[.allowBluetooth, .defaultToSpeaker]`.
- Handle `interruptionNotification`: an incoming call ends the conversation cleanly and saves what exists.
- Handle `routeChangeNotification`: headphone unplug, Bluetooth connect and disconnect, without dropping the session.
- Backgrounding ends the conversation with a saved state. No background audio mode in V0. That is an App Store review conversation and a battery risk, both for a feature nobody has asked for.
- An input level meter on screen while recording, mirroring the web diagnostics. The Teams virtual device lesson applies to Mac only, but a dead meter is still the fastest read on a silent mic.

### IOS-5. Capture path **[Locked] [V0] [P0]**

Record locally, request a signed upload URL from the API, PUT the file to Storage, then `POST /api/v1/captures` with the storage path and the explicit `scope_id`. The server transcribes with Scribe. The ElevenLabs key never reaches the device.

Interviews use the ElevenLabs Swift `Conversation` object directly with an ephemeral token minted by the API. The transcript posts as a capture on completion.

### IOS-6. Offline queue **[Locked] [V0] [P1]**

Voice memos only. If the upload fails, the audio file and its intended `scope_id` persist to disk and retry on next foreground. Interviews are not queued, they require connectivity by nature. A memo that vanishes because of a dead zone is the kind of first impression that ends a beta.

### IOS-7. App Store items **[Locked] [V0] [P0]**

Scheduled into Phase 8, not left to the submission attempt.
- `NSMicrophoneUsageDescription` with a specific purpose string.
- Privacy manifest declaring audio recording and the data categories collected.
- A consent screen shown before the first recording, describing what is stored and for how long, with a link to the policy.
- TestFlight for the beta cohort. No public release in V1.

### IOS-8. What Claude Code cannot verify **[Locked]**

The agent may run `xcodebuild` for compile and lint. The agent may not claim verification of: microphone capture, audio routing, interruption behaviour, background transitions, the ElevenLabs conversation, upload retry, or anything visual. Those are Todd on a physical device. This is the same rule as the web miner: the live run is the only proof.

---

## 7. Phases

One PR each. Branched off main. Human merges. Do not start a phase until the previous one is merged, except where marked parallel.

| Phase | Content | Repo | Gate |
|---|---|---|---|
| 1 | SC-2, SC-3 migration and new RLS policies, flag off | web | Harness still 8 of 8 on old policies |
| 2 | SC-4 harness extension to 11 surfaces, flip `SCOPES_ENABLED`, drop old policies | web | 11 of 11 pass, live smoke on Todd's account |
| 3 | API-1 routes, web writes converted to explicit scope, OB-1 event columns | web | Every write path names its scope, verified by grep and by test |
| 4 | Workspace UI on web: create, invite, switch, member list. SC-5 promotion. | web | Two real users in one workspace, one mine, both see it |
| 5 | MT-1 to MT-5, MT-7, OB-2 ledger, OB-3 console | web | A capture burst produces one mine. A forced ceiling breach defers and recovers. |
| 6 | iOS spike: project, auth, read-only Memory, audio session, level meter. No capture. | memo-ios | Todd signs in on device, reads his graph, sees the meter move |
| 7 | iOS capture: memo, upload, interview, offline queue | memo-ios | Memo recorded on device appears after a mine |
| 8 | iOS scope switch, promotion action, consent screen, privacy manifest, TestFlight | memo-ios | Second user installs from TestFlight |

Phase 6 may start in parallel with Phase 3, because it only reads and the read policies land in Phase 2.

---

## 8. Open items

**Blocking. Resolve before the phase named.**

| ID | Question | Blocks |
|---|---|---|
| D-1 | Is Xcode on the machine Claude Code runs on, and is Todd the builder or is someone else? | Phase 6 |
| D-2 | Confirm A-5. Is anything the three beta users hold at risk from an additive backfill? | Phase 1 |
| D-3 | Workspace invite delivery uses the existing Resend SMTP with a new template. Confirm no separate domain or sender is wanted for Enterprise. | Phase 4 |

**Exploratory. Options get proposed, the agent does not pick.**

| ID | Area |
|---|---|
| E-1 | What a workspace member sees of who said what. Full attribution on every node, attribution on request, or none. Affects the Memory read UI in Phase 4 and the trust conversation with an enterprise buyer. |
| E-2 | Handoff freshness from EM-1. A staleness signal per node plus a digest. V1 or V2. |

---

## 9. V2, captured not designed

- Cross-scope entity linking as an overlay.
- Batch API lane for deferred mines (MT-8).
- EM-2 scanner and ranker as modes of the mine job.
- EM-3 folder autonomy, still blocked behind a bounded action set and an approval queue.
- Miner atomicity hardening, commit progress per pass.
- Contradict-the-miner dispute action.
- Split-person correction, Phase 4 of the old Phoenix roadmap.
- Android.
