# Backend flows

How data moves through Memo Phoenix, and where each path emits observability events
(the durable `observability_events` layer, read at `/admin/observability`). These are
the backend flows a fresh session should read before touching capture, interview, or
the miner.

- [capture.md](capture.md) - text and voice-memo capture into `captures` (append-only)
- [interview.md](interview.md) - the ElevenLabs voice interview (open, daily, onboarding), pause, and temporal context
- [miner.md](miner.md) - the miner pipeline, its triggers, the run lock, and heartbeats

Shared invariants across all flows:

- Every write is scoped to `user_id`; RLS is FORCE-enabled on every table.
- `captures`, `corrections`, `confirmations` are append-only; provenance is mandatory
  (`capture_id` on raw, `source_claim_ids` on canonical).
- Observability records STATUS, ERROR TYPE/MESSAGE, TIMINGS, and METADATA only, never
  user content or secrets. See `.claude/skills/observability/SKILL.md`.
