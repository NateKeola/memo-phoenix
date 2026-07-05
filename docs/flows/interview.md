# Interview flow

A voice conversation with the ElevenLabs Conversational AI agent. Three modes share
the pipeline: `open` (brain-dump), `daily` (graph-aware brief), and `onboarding`
(first-run intro). Each interview writes exactly ONE append-only `captures` row at the
end, so the miner folds it in like any capture.

Widgets: `components/interview-widget.tsx` (open/daily, at `/capture/interview`) and
`components/onboarding-interview.tsx` (onboarding, at `/onboarding`). Both are
client-only (the SDK is browser-side) and import statically (a `next/dynamic` deferral
remounted and killed the socket after one turn; see the decision log).

## Start

Client -> `POST /api/interview/start` with `{ mode, timeZone, target? }`.
The route (server):
1. composes the per-session system prompt: the bible (`lib/interview/compose.ts`)
   with `{{user_name}}`, `{{DAILY_BRIEF}}` (daily/target only), and
   `{{CURRENT_DATE_TIME}}` filled. Onboarding uses the isolated onboarding bible.
2. `daily`/target composes a deterministic brief (`lib/interview/briefing.ts`); an
   empty brief degrades to open behavior (the first message matches the effective mode).
3. records an `interview_sessions` row and mints a signed ElevenLabs WebSocket URL.

The browser applies the system prompt + first message as `conversation_config_override`
at `startSession` (the SDK only supports overrides client-side; the agent's dashboard
override toggles must be ON).

### Temporal context

The client sends its IANA `timeZone` (`lib/tz.ts` `localTimeZone()`). `formatNow`
renders the real local "now" (with the short zone name) into `{{CURRENT_DATE_TIME}}`,
so the agent knows the actual date/time where the user is (the server runs in UTC).
Both daily and onboarding bibles carry the placeholder; an invalid/absent zone falls
back to the server zone.

## Live: pause

Both widgets have a Pause/Resume control. Pause calls the SDK `setMuted(true)` so the
agent hears nothing and holds off, and shows a clear paused state; Resume unmutes.

CRITICAL for onboarding: pause also SUSPENDS the pacing timers. Onboarding has a soft
wrap (~10 min -> cue the warm close) and a hard backstop (~15 min -> end). On pause
those are cleared; on resume they are re-armed for the REMAINING budget (the paused
span is not counted), tracked via `timersArmedAt` + `accumulatedPausedMs`. So a pause
never triggers an early wrap-up or an "ended on silence".

## End

Client -> `POST /api/interview/end`. The route fetches the authoritative transcript
from ElevenLabs (retry while processing; client transcript as fallback), and if long
enough writes the `captures` row (`mode='interview'`). Too-short conversations are not
captured. Onboarding then marks `app_metadata.onboarded=true` and hands off to
`/building` for the first mine.

## Observability

Server (`interview` subsystem): `start_error` (session insert / signed-url failures),
`started` (ok, meta mode/effective_mode/brief_item_count); end route: `too_short`
(warn), `capture_insert` error, `captured` (ok).

Client (`interview`/`onboarding` via `/api/obs`): `mic_ok` / `mic_error`, `connect`,
`disconnect` (with `reason` + `closeCode`; error-level when unexpected), `error`,
`pause`, `resume`. Content is never sent; only the shaped meta keys survive the bridge.
