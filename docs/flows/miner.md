# Miner flow

The miner reads `captures`, extracts per-capture `raw_*` rows, and derives the
`canonical_*` graph. The LLM is one stage; code orchestrates. It runs with the
service-role key, so per-user isolation is enforced by CODE filtering every query on
`user_id` (audited + guarded by `scripts/check-miner-isolation.ts`), not by RLS.

## Triggers (exactly two, plus onboarding)

- Manual "Run now" (`/miner`) -> `POST /api/miner/run { trigger:'manual' }`.
- Daily threshold-gated cron (`vercel.json` -> `/api/cron/miner-sweep`, `CRON_SECRET`
  -gated): mines only users with >= `AUTO_RUN_NEW_CAPTURES` unmined captures, one
  dispatch per user via the GitHub Action.
- Onboarding (`trigger:'onboarding'`) runs inline on `/api/miner/run` so a new user
  watches their first corpus build.

Off-machine runtime: the GitHub Action (`.github/workflows/miner.yml`) runs the
`npm run miner` CLI per user (no serverless timeout). The Vercel route handles small
inline runs (onboarding); larger ones offload to the Action.

## The run lock

`mineWithLock(userId, trigger, runtime)` wraps `mine()` in a `miner_runs` row that is
also the LOCK: a partial unique index (`where status='running'`) allows at most one
active run per user, so the CLI, the Action, and the Vercel route cannot collide (a
colliding insert -> `already_running`). A stale `running` row older than 20 min is
reclaimed. `miner_runs` also carries the heartbeat/stage (migration 0017) the console
reads to show a `running` vs `stalled` run.

## Incremental (flag `MINER_INCREMENTAL`)

Extraction is always per-capture incremental (`miner_state` markers). With the flag
on, derivation is incremental too: only new captures' claims are re-derived and MERGED
into canonical (provenance union). Off is a full recompute. Streaming model calls
(`callClaude` -> `messages.stream().finalMessage()`) avoid the SDK's >10-min
non-streaming refusal.

## Observability

- `/api/miner/run`: `miner` `dispatch_error` if kicking off the Action fails.
- `/api/cron/miner-sweep`: a `cron` summary event (meta `{checked, dispatched}`).
- Run state itself lives in `miner_runs` (status, trigger, runtime, stage, heartbeat,
  error), which the admin console reads directly and renders with a `stalled` marker
  when a `running` row has no heartbeat for >10 min. The miner's own per-pass counts
  go to `telemetry_events` (`miner_run`) and the run summary.

The console therefore answers, without a live tail: is a run active or stalled, when
did the last run finish, what did it change, and did the last dispatch error.
