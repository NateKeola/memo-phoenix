---
name: observability
description: Use when adding, reading, or debugging Memo Phoenix observability. Explains the durable observability_events layer, the admin console, how to emit events from server and client, the privacy rules (never log secrets or content), and how to read subsystem health.
---

# Observability (Memo Phoenix)

Durable, admin-only visibility into what the app is doing across devices and users.
"Works on my laptop" hides failures elsewhere; this layer records status, error
detail, and timings so a failure on another device/user is visible after the fact.

## The store

`observability_events` (migration `0018_observability_events.sql`): shaped columns
only, plus a `meta` jsonb for counts/ids/flags. FORCE RLS, per-user SELECT policy;
writes are service-role only. `user_id` is nullable (system events like cron have no
user). Mutable operational state (no append-only/history trigger).

Columns: `subsystem, event, level (info|warn|error), status, duration_ms,
error_type, error_message, meta, user_id, created_at`.

## The one privacy rule (non-negotiable)

NEVER write user content or secrets. Record STATUS, ERROR TYPE/MESSAGE, TIMINGS, and
METADATA only. No transcripts, no capture bodies, no keys. `meta` holds counts, ids,
MIME types, states, flags. Error messages are truncated (500). This is enforced in
three places; keep all three intact:
1. the schema has no content column,
2. `lib/observability.ts` truncates and only writes shaped fields,
3. `app/api/obs/route.ts` whitelists meta keys (`META_KEYS`) and events/subsystems.

## Emit an event

Server (routes, server actions, the miner): `lib/observability.ts`.
```ts
import { logObs, obsError } from '@/lib/observability'
await logObs({ subsystem: 'scribe', event: 'transcribe_ok', status: 'ok',
  userId: user.id, durationMs: Date.now() - t0, meta: { bytes, chars } })
// at a catch boundary:
await logObs({ subsystem: 'capture_memo', event: 'error', status: 'error',
  userId: user.id, ...obsError(err), meta: { chars } })
```
`logObs` is fire-and-forget (never throws into the caller). If you don't pass
`level`, it is `error` when an error field is set, else `info`.

Client (the interview widgets run in the browser): `lib/obs-client.ts` -> `/api/obs`.
```ts
import { reportObs } from '@/lib/obs-client'
reportObs({ subsystem: 'interview', event: 'connect', meta: { mode } })
```
The bridge only accepts a fixed `ALLOWED_SUBSYSTEMS` / `ALLOWED_EVENTS` set and a
whitelisted `META_KEYS`; anything else is dropped. To add a new client event/key,
add it to those allowlists in `app/api/obs/route.ts` (and keep it non-content).

Subsystems: `auth | capture_text | capture_memo | scribe | interview | onboarding |
miner | cron | surface | api`.

## Read it

`/admin/observability` (operator-gated by `isOperator`, never shown to a regular
user). It reads across users via the service-role client (same operator-mediated
pattern as the cron sweep and invites); RLS still blocks every non-service client.
Shows: subsystem health cards, recent errors with detail, miner runs (with a
`stalled` state when a run has no heartbeat for >10 min), and invite acceptance.
`ObsRefresh` re-runs the server component every 8s.

Health rollup (`rollUpHealth`): a subsystem is healthy unless it has an `error`-level
event in the last hour; the last error message is exposed on the card.

## Verify

`node scripts/check-obs-db.mjs` (or `npm run check:obs`): a self-cleaning live-DB
smoke that writes a healthy + a forced-failure event, reads them back, rolls up
health, asserts the privacy properties (shaped-only columns, no long free text in
meta), and deletes the test rows. `npm run smoke` runs it alongside the RLS,
multi-user, and invite guards in one command.

## What is NOT captured here

The live voice interview, a real Scribe memo upload, and a real miner run cannot be
driven headlessly; they are the operator's acceptance checks. This layer proves the
surrounding deterministic behavior and records what those live paths report.
