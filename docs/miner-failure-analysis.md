# Miner failure analysis (2026-06-30, corrected)

Diagnostic-only. No code changed, and the canonical graph was NOT touched. Written
from the live dev DB (`azlobwtiptvarfeukzcv`) via the Management API and from reading
`packages/miner-core/src`.

## Correction notice

An earlier version of this document concluded the graph was duplicated 4x-7x with a
broken id-preserving upsert. That was WRONG, from two compounding analysis errors:

1. The duplicate-detection queries did not filter by `user_id`. The dev DB holds the
   real user (natekeola, `691c75b5`, = `MEMO_USER_ID`) PLUS six `inc-harness-*`
   throwaway users the incremental equivalence harness clones the corpus into and
   mines. Unfiltered, `canonical_people` is 238 rows and "Andy Smalley" appears 7
   times: that is one row per user (real + 6 clones), not seven duplicates. Each
   user's id differs because `canonicalId` hashes `user_id`.
2. A hand-rolled uuidv5 replication used to verify ids passed the RFC 4122 test vector
   but still diverged from the real code on the canonical-namespace path, which
   falsely reported "0/46 stored ids match the deterministic id".

Running the REAL `identity.ts` natively (`node --experimental-strip-types`, which
bypasses the wedged tsx) reproduces the stored ids exactly:
`canonicalPersonId(user, "Jake", "Richards")` = the stored `2f9dfb06-...`. So the
miner's id derivation is correct.

## Corrected picture

Scoped to the real user (`691c75b5`), the graph is CLEAN and healthy:

| table | rows | distinct labels | duplicate groups |
|---|---|---|---|
| canonical_people | 46 | 46 | 0 |
| canonical_places_orgs | 56 | 56 | 0 |
| canonical_projects | 20 | 20 | 0 |
| canonical_events | 29 | 29 | 0 |
| canonical_facts | 71 | 71 | 0 |
| canonical_commitments | 24 | 24 | 0 |
| canonical_relationships | 55 | 55 | 0 |
| insights | 53 | 53 by statement | 0 |

- Referentially consistent: 0 relationships with a dangling endpoint, 0 commitments
  with a dangling `person_id`.
- id-stable: the id-preserving upsert works (a clean, dup-free graph that has been
  mined multiple times: people were written across 2026-06-18, 06-20, 06-28).
- Last write was the 2026-06-28 successful mine. Nothing was written on 2026-06-30
  (those mines failed); the 06-30 explosion in the unfiltered counts was entirely the
  harness clone users.

There is NO duplication and NO id bug. Nothing to dedupe or re-key.

## The actual problems (confirmed)

### 1. Vercel kills every full recompute at 300s
`app/api/miner/run/route.ts` sets `maxDuration = 300`. A full recompute takes ~22 min
(the 2026-06-28 success was 1,344,217 ms). Vercel hard-kills the function at 300s, so
the `miner_runs` row it created is never closed; it sits `running` (a zombie) until
`STALE_RUN_MS` (20 min) passes and the next attempt reclaims it as
`stale run reclaimed`. All the real user's recent Vercel runs are this pattern; the
current `running` row (Jul 1 02:59 UTC) is a live zombie.

### 2. The people pass truncates its JSON at the token cap
`packages/miner-core/src/config.ts`: `MAX_TOKENS = 16000`, adaptive thinking ON at
`EFFORT = 'high'` (thinking shares the 16k budget), `pageLimit() = 200`. `callClaude`
is non-streaming. When thinking plus the emitted node JSON exceed 16k, the response is
cut off mid-string and `JSON.parse` throws `Unterminated string` (the 2026-06-30 CLI
run: position 25260 on `canonical_people batch 1`). `MAX_BATCH_ATTEMPTS = 3` retries
hit the same structural limit and the pass throws, failing the mine. Even the clean
46-person graph reconciled from 118 `raw_people` claims is enough to trigger this once
thinking eats most of the budget.

### 3. Chicken-and-egg: the incremental baseline never completed
`MINER_INCREMENTAL=1` is set, but the real user has 0 `incorporated:` markers.
`runIncrementalDerivation` treats "no markers" as "no baseline yet" and runs a FULL
recompute, marking captures incorporated only on success. Because every mine since the
flag was set failed at (1)/(2), the baseline never completed, so every attempt is a
full recompute: exactly the slow, truncating path. Incremental cannot help until one
full baseline succeeds.

## The fix (non-destructive)

1. Harden the token budget so no pass can truncate: lower `MINER_PAGE_SIZE` (e.g. 40
   to 60), and/or raise `MINER_MAX_TOKENS`, and/or lower `MINER_EFFORT` so thinking
   does not consume the output budget. (Streaming `callClaude` is the deeper fix and
   is out of scope.)
2. Run the one full baseline OFF the 300s path: the GitHub Action `miner.yml` (no
   timeout, and tsx works on GitHub runners) with the real user's id. Once it
   completes, the `incorporated:` markers are written and subsequent mines are
   incremental, small, and finish under the cap even on Vercel.
3. Optionally reclaim the current zombie `running` row (or wait for `STALE_RUN_MS`).

No backup, no dedupe, no re-key: the graph is healthy.

## Environment notes

- tsx / esbuild is wedged on this machine, and the Anthropic SDK's fetch/undici throws
  here, so the miner cannot be run locally. The baseline mine is the operator's step
  via the Action. `node --experimental-strip-types` works for pure modules (used to
  verify identity), and `node:https` works (used for all DB queries).
- The Anthropic API itself is up (the usage limit has lifted; a direct probe returned
  200).

## On visibility (the original request)

The `/miner` page shows only `running` / `done` / `error` from `miner_runs`, with the
summary written only at the end, so a run that dies mid-pass shows an indefinite
"Updating your memory..." with no error surfaced. Real per-pass progress plus surfacing
the error/zombie state is worth building, separate from getting the baseline to
complete.
