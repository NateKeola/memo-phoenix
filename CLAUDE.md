# CLAUDE.md — Memo Phoenix

Single-user personal knowledge and companion system. Capture (voice memo, text, interview) feeds a miner that builds a personal knowledge graph, which a companion layer reads. The source of truth for scope and architecture is `docs/memo-phoenix-spec.md`. Read it before building. Build the V0 surface of a feature, then stop. V0 means exists and works, not polished.

## How to read the spec
- LOCKED items are constraints. Implement as written.
- OPEN-EXPLORATORY items: implement the recommended option and note the assumption in the PR description. Do not stall.
- If something contradicts a LOCKED item or is ambiguous at the architecture level, ask before building.

## Standing rules (every session)

### Data and security
- Single-user tenancy: `user_id` is the tenant key. RLS on every table, scoped to `user_id`. No exceptions.
- Service role key server-side only. Never in client code or the browser bundle.
- JWT validation on every authenticated route. Principle of least privilege everywhere.
- `captures`, `corrections`, `confirmations` are append-only. Every raw row carries `capture_id`. Every canonical row carries `source_claim_ids`. Provenance is mandatory.
- Canonical is recomputed from the full ground-truth set (raw + corrections + confirmations) on every run. Never edit canonical directly.
- Every canonical row carries a temporal class (evergreen | dated | decaying), a validity interval (`valid_from`, `valid_to`, `superseded_by`), plus `confidence`, `salience`, `last_confirmed_at`.
- Schema changes go through Supabase migration files only. No manual dashboard schema edits. Never apply an empty migration.

### Architecture
- The LLM is one stage of a deterministic pipeline, not the orchestrator. Routing goes in code wherever code can decide it.
- Hard-gate high-stakes actions (sending email, scheduling, anything with an external side effect) in code, not in a prompt instruction.
- Deterministic prompt composition only. No LLM meta-prompt.
- Direct Anthropic SDK. No LangChain.
- Cache system prompts (pad past 4096 tokens, mark ephemeral). Telemetry from day one: tool calls, miner runs, cache hit rate.
- Prompt template `.md` edits require regenerating and committing the `.generated.ts` files. Runtime filesystem reads fail in Vercel serverless.

### Separation and credentials
- Memo Phoenix is its own world: own repo, own Supabase account or org, own Vercel project. There is no path to the Miine canonical Supabase project. Do not reference or connect to it.
- The GitHub token is a fine-grained PAT scoped to this repo only.
- Merge-driven model: the only privileged action from this environment is `gh` PR create and merge. Once wired, migrations apply via a GitHub Action on merge to main, and Vercel deploys via the Git integration. Platform tokens (Supabase, Vercel) live in GitHub Actions secrets, not in this environment. During bootstrap (PR0 and PR1) applying migrations directly to the dev project with `supabase db push` is acceptable.

### Writing
- No em dashes in any document or output.
- Direct, simple language. No formatting flourishes.

## Decision log
Append a dated entry after every substantive decision.

- 2026-06-16: Project bootstrapped. Spec v0.1 locked. Build follows spec §16 PR sequence. Structure is a single Next.js app plus a `packages/miner-core` package. Freshness model is the self-refreshing corpus: validity intervals and supersession, decay by temporal class, re-confirmation folded back through the interview loop, salience-gated. Companion actions are draft-and-confirm in V0. Tenancy is single-user via `user_id` with RLS retained.
- 2026-06-16: PR0 (Foundation) built. npm-workspace scaffold (single Next.js App Router app plus `packages/miner-core` stub), single-user Supabase Auth (`/login` only, no signup UI), full data spine (captures/corrections/confirmations, 8 `raw_*`, 8 `canonical_*` with the mandatory shared block, collections, aux), `reconfirm_candidates` computed view, `telemetry_events` sink, append-only via `forbid_mutation()` triggers, canonical history via `snapshot_canonical()`, FORCE RLS on every table scoped to `user_id = auth.uid()`, migrate-on-merge CI. OPEN-EXPLORATORY lean options taken: #2 no pgvector in PR0, #3 loose canonical columns, #5 no decay constants in DDL, #8 corrections/confirmations separate, #9 reconfirm view computed, #10 single app plus one package. `superseded_by` is a plain uuid with no FK (a self-FK would fight the nightly recompute).
- 2026-06-16: Migrate workflow secrets (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`) must be set as GitHub Actions secrets before PR0 merge. Otherwise the first `migrate.yml` run fails with a harmless red X, since the PR0 schema is applied to dev by direct `supabase db push` during bootstrap.
- 2026-06-16: Forward (do not build now): if `migrate.yml` is ever pointed at a production project, gate it behind a GitHub Environment with required approval. The dev project keeps auto-applying.
- 2026-06-16: PR1 forward note A: `captures` is hard append-only via `forbid_mutation`, so any "already processed" state the miner needs lives in a SEPARATE table, never as a column on `captures`.
- 2026-06-16: PR1 forward note B: canonical recompute in PR1 is an id-preserving UPSERT, not delete-and-reinsert. Delete/reinsert would write a full snapshot of every canonical row to `canonical_history` every night (burying real history in recompute churn) and would break `superseded_by`, since ids would not survive. Preserve ids, update in place.
