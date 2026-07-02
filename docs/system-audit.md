# System audit: whole-flow findings and pre-fix state (2026-07-01)

Read-only audit of Memo Phoenix against the live database and deployed code. Method: 11 parallel
audit passes (auth/entry, capture, miner pipeline, read surfaces, ops/security, plus 6 PR-claim
verifiers), every high/critical finding and every non-confirmed claim independently re-verified by
an adversarial checker (29 verification passes; 2 preliminary findings were rebutted and are
recorded as corrected in `docs/pr-verification.md`). All data inspection was per-user-scoped
(real user `691c75b5`); the 8 `inc-harness-*` accounts are test residue and were excluded. The
companion documents: `docs/pr-verification.md` (claim verdicts), `docs/observability-plan.md`
(instrumentation design). This document records the PRE-FIX state; fixes land separately.

## The headline: five active harms

1. NEAR-DUPLICATE MINTING IS LIVE AND GROWING (high). The 07-01 incremental fold inserted 24
   people with `unchanged: 0`; at least 5 are near-duplicates of established people (Cole, Dad,
   Lisa, Max, Justin Keading vs Cole Richards, Brian, Lisa Hennessy, Max States, Justin Keating),
   plus duplicate commitments ("Text Max about volleyball" open, duplicating a done task; three
   "College Tour" variants; two dad-volleyball follow-ups split across Brian and Dad). Three
   compounding causes, each verified:
   - Identity is an exact-normalized-label hash when `MINER_STABLE_IDENTITY` is off, and it is off
     in every runtime (env unset; `entity_aliases` has 0 rows; the PR #17 resolver never activated).
   - The incremental people/places/facts passes send the model `canonical_nodes: []`
     (`packages/miner-core/src/incremental.ts:528,542,578`), so the model cannot resolve a new
     mention against the existing graph. This contradicts the pass's own design
     (`docs/incremental-miner.md:119-120`: "feed them plus the existing canonical nodes as
     context") and the code comment above the resolver call.
   - Nothing ever retires a current row that a re-derivation stops emitting:
     `writeCanonical` (stage-common.ts:317-353) only upserts what it is handed, and the only
     retirement paths are corrections and discrepancy supersession. So once minted, a duplicate is
     immortal until a human merges it. This also falsifies the documented "the full rebuild trues
     insights up" claim: nothing retires stale insights either (16 current `recurring_tension`
     insights have accumulated), or any other no-longer-emitted node.
   Read-surface damage is live: exact-label match outranks alias match in retrieval
   (`lib/chat/retrieval.ts:138` scores label 100 vs alias 95), so "who is Cole" ranks the thin
   07-01 fragment above the established row; Today shows a completed task again as open (the
   overlay correctly refuses to transfer done-state to the duplicate); /people shows 69 rows
   including the clusters.

2. EVERY IN-APP MINE OF THE REAL CORPUS DIES, INVISIBLY (high). The Vercel run route has
   `maxDuration=300`; the real corpus needs 13 min (incremental fold, measured 779s) to 22 min
   (full). All three in-app attempts (06-30 08:10, 06-30 17:30, 07-01 02:59) were killed and left
   zombie `running` rows for 1 to 9 hours, because `miner_runs` gets no mid-run writes and stale
   reclaim happens only at the START of the NEXT run (`run.ts:113-131`). While a zombie exists:
   /building shows "building your memory" forever, /miner shows a run in progress, AND
   `shouldAutoRun` is false (`lib/miner/state.ts:117,126`), which also makes the cron sweep skip
   the user, so a zombie suppresses background mining indefinitely. The only successful mines ran
   on the CLI or a hand-dispatched GitHub Action. Related: the stale-reclaim threshold (20 min) is
   SHORTER than an observed legitimate full run (22 min), so a concurrent trigger could reclaim a
   LIVE run and start a second miner against the same user.

3. THE NEXT REQUIRED MINE IS STRANDED (high). Three corrections were filed on 07-01 after the last
   mine (merge Girlfriend->Morgan, rename Morgan->Morgan Alexander, rename Nate->Nate Tennant), so
   the corrections fingerprint is stale and the next run is forced onto the FULL path
   (`incremental.ts:481-502`), which no in-app path can complete (see 2), and corrections do not
   count toward the auto-run measure (`lib/miner/state.ts:120-126` counts new captures only), so
   the cron will not fire for them either (2 new captures < threshold 10). The user's merges and
   renames sit unapplied until the operator hand-dispatches the Action. Additional hazard for that
   run: rename rewrites are label-keyed and ignore the `person_id` carried in the correction
   payload (`corrections.ts:81-88,138-140`), so the pending bare-label rename "Nate" -> "Nate
   Tennant" will catch ANY node the model emits with the exact label "Nate"; the model demonstrably
   drops name qualifiers (it minted bare Cole/Lisa/Max on 07-01), and a "Nate (friend)" row exists,
   so the friend's claims can be merged into the user's own person row with no error anywhere.

4. ONBOARDING CAN TRAP AND SILENTLY DISCARD A NEW USER (high). The onboarding interview's
   `onDisconnect` only logs (`components/onboarding-interview.tsx:106-110`); after the known
   ends-after-greeting failure (still undiagnosed, instrumentation shipped in PR #23) the UI shows
   "Listening..." indefinitely against a dead socket. The eventual escape ("End now") captures
   nothing for a too-short transcript, yet `/api/onboarding/complete` unconditionally sets
   `onboarded=true`, so the user lands in an empty app and the gate never sends them back through
   onboarding: their first-run content is silently lost. Live corroboration: 6 of 16 open-mode
   interview_sessions never ended. Compounding: the middleware gate has no skip affordance, so a
   user for whom the voice agent fails is hard-blocked from the entire app (see 5).

5. THE ONLY INVITED BETA USER HAS BEEN LOCKED OUT SINCE 06-21 (medium, verified path by path).
   Todd's account exists (created 06-21 via the old invite flow, passwordless), app_metadata
   invited=true onboarded=false, invites row status=pending with `invited_user_id` NULL, and 0
   captures/runs/sessions. Every self-service path terminates circularly: Sign in fails (no
   password); Create account throws AccountExistsError and says "sign in instead"; forgot-password
   on main says "contact your admin". The operator-side reset also fails: revoke+re-invite cannot
   clear the stale account because revoke only deletes when `invited_user_id` is set
   (`app/admin/actions.ts:153`), which it never was for Todd. The ONE working path is the PR #31
   admin recovery link (proven independent of SMTP and of the redirect allowlist), followed by the
   onboarding voice interview (see 4 for its failure mode).

## Live configuration reality (Supabase project azlobwtiptvarfeukzcv)

- `disable_signup: true` (correct), `mailer_autoconfirm: true` (correct).
- CUSTOM SMTP NOT CONFIGURED (`smtp_host` unset): all auth email rides the built-in rate-limited
  sender. This falsifies open PR #32's premise; self-service reset emails will frequently not
  deliver until SMTP (e.g. Resend with a verified sender) is configured.
- `site_url = https://memo-phoenix-nu.vercel.app/`; `uri_allow_list` EMPTY. GoTrue validates
  redirect_to by scheme+host against site_url, so same-host redirects (all the app's links) are
  honored; the empty allowlist is currently harmless but should still be populated for safety.
- Vercel env (inferred from behavior): `MINER_USE_GITHUB_ACTION` is NOT active (manual in-app runs
  executed inline on Vercel and died); the cron sweep has never dispatched (all 6
  `miner_run_triggered` events are the in-app route; all 4 Action runs ever are workflow_dispatch).
  Whether CRON_SECRET/GITHUB_DISPATCH_TOKEN are set cannot be determined from here; no cron
  invocation leaves any trace when it does nothing (an observability gap in itself).
- The migrate-on-merge CI has NEVER succeeded: 9/9 `migrate.yml` runs failed (Actions secrets never
  set). Migrations 0001-0009 were applied via `supabase db push`, 0010-0015 via `scripts/db.mjs`
  or by hand. The recorded schema state IS clean (0001-0015 applied and consistent with the live
  catalog), but the documented merge-driven pipeline does not operate.

## Data-quality snapshot (pre-fix, real user, all queries user-scoped)

- captures 26 (24 extracted+incorporated; 2 person-targeted texts pending). Text capture max
  85,182 chars; no size validation anywhere.
- DOUBLE-INGESTED CAPTURES: two identical-md5 pairs. (a) 59,620 chars, 06-30 06:40:03.86 and
  06:40:05.78 (both extracted: 46 and 44 claims; 9 current people cite claims from BOTH copies).
  (b) 426 chars, 06-19 00:49:54.40 and 00:49:55.86. Root cause: the text capture form has no
  pending state and no idempotency key (`app/capture/text/page.tsx:23-31`, `lib/captures.ts:28-42`);
  the other capture surfaces have busy guards. No retraction mechanism exists at any layer
  (captures/raw are hard append-only via forbid_mutation; no exclusion table; no UI).
- Current canonical: people 69 (9 superseded), places 72, facts 109, commitments 41,
  relationships 76 (28 retired), events 46, projects 26, insights 53 (2 retired).
  canonical_history 1355 rows, bursts exactly on mine days.
- Near-duplicate people clusters current: Cole/Cole Richards, Dad/Brian, Lisa/Lisa Hennessy,
  Max/Max States, Justin Keading/Justin Keating, Todd/Todd Gavin, Linnea/Linnea Skinner,
  Nate/Nate (friend) (the last pair is two genuinely distinct people that share a bare label with
  the user's own node; see the rename hazard above). Duplicate commitments as listed in the
  headline. Exact-normalized-label duplicate groups: 0 everywhere (the dups are variant labels).
- Insight accumulation: 16 recurring_tension, 6 overcommitment, 6 hub_person, 4
  neglected_relationship, 3 chosen_family currently live; nothing retires them.
- Dangling `superseded_by`: person 2aa3a797 (Morgan Alexander Peterson, retired 06-28) points at
  538f28e2 which does not exist: `supersedeLosers` retires the loser without verifying the survivor
  row materialized (`corrections.ts:149-163`), and the model emitted the person under a different
  label that run. The person is currently absent from the graph.
- Provenance: CLEAN. 0 canonical rows with missing/empty source_claim_ids; sampled chains resolve
  raw -> capture within the same user; 0 orphan claim references found.
- Dangling relationship endpoints: 0 of 76 (checked against all current node tables incl. facts).
- entity_aliases: 0 rows (stable identity never cut over). collections/collection_items: 0 rows
  despite 27 raw_collection_mentions (extraction emits them; no derivation consumer exists; the
  chain dead-ends, PR1-era deferral never picked back up). discrepancies and open_threads TABLES:
  0 rows ever; the pipeline counts these outputs in run summaries but discards their content
  (the PR0 aux tables are dead).
- companion_state: 4 rows, all still exact-matching current commitments.
- interview_sessions: 16 open + 2 daily; 7 never ended (abandoned/failed-connect residue).

## Additional defects and fragilities (verified; medium unless noted)

- Any visit to /building auto-fires an inline mine as trigger='onboarding'
  (`components/building-status.tsx:25-46`), bypassing the threshold check (route guards only
  trigger='auto') and the Action offload (route excludes onboarding from offload), guaranteed to
  zombie on a mature corpus (happened live 06-30 17:30). High.
- Mid-run death between the raw insert and the extract marker re-extracts that capture with a
  fresh LLM call; nondeterministic rewording mints different content-hash raw ids, permanently
  appending near-duplicate claims (`extract.ts:119-131`). This is a second, independent
  duplicate-claims source beyond the double-submit.
- Voice memo audio is unrecoverable on STT failure (no retry with the recorded blob; audio not
  stored by design). Interview end failure similarly loses the conversation with no retry.
- `resolveTargetLine` resolves a capture target without `valid_to is null`, so a person-targeted
  capture can attribute to a superseded row's label. Low.
- find_commitments person filter matches resolved label only, not aliases ("what do I owe my dad"
  misses rows whose person resolved under another label variant).
- Chat/companion read surfaces ignore companion_state (a done follow-up is still presented as open
  by chat answers), and the chat system prompt's guidance for duplicate people is contradictory.
- No self-person concept: the user's own node is listed and nudged like any contact.
- invites RLS gap: INSERT/UPDATE/DELETE policies allow any authenticated user to write invites
  rows scoped to their own user_id, while `isInvited()` matches by email only, so an
  already-invited user with the anon key could allowlist an arbitrary email (defense-in-depth,
  medium-low; the anon key is not shipped in the bundle but is not a secret by design).
- updatePasswordAction (reset page) checks authentication but not the allowlist, so a revoked user
  holding a live recovery session can still set a password (they remain locked out of all data
  surfaces). Low, borderline by-design.
- Unauthenticated visitors can drive unbounded `isInvited` service-role reads and reset-email sends
  (no app-level rate limiting; GoTrue rate-limits only the email send itself). Low at beta scale.
- Telemetry attrs carry some personal free text (correction labels, routing hints). Low,
  by-design-adjacent; worth a scrub pass before any multi-tenant future.
- Miner env matrix inconsistency: the Action defaults MINER_INCREMENTAL=1, the Vercel/inline
  runtime does not (unset = full recompute), so the same button can produce different derivation
  modes depending on where it lands. The incremental path also skips the per-pass stage telemetry
  the full path emits, and the freshness telemetry series went dark on the incremental path (its
  reconcile counts ride the `incremental` event instead).

## What is NOT wrong (verified clean, recorded to prevent future false alarms)

- RLS: all 31 tables FORCE RLS, every policy exactly `user_id = auth.uid()` to `{authenticated}`,
  canonical bucket and telemetry SELECT-only for clients, the one view is security_invoker, only
  `snapshot_canonical` is SECURITY DEFINER, client roles cannot bypass RLS.
- The auth guard covers every protected page, action, and API route; signups are disabled at the
  platform level with no bypass; the service-role key and other secrets are absent from the client
  bundle; no secrets in tracked files.
- The app has never written canonical directly (code paths + history-burst timing both verified).
- Provenance is 100% present and resolvable. Zero dangling relationship endpoints.
- The streaming fix (PR #30) works and its live before/after evidence is clean; token settings are
  applied; the run-lock (partial unique index) prevents true concurrent runs; double-trigger safety
  in the run route is sound; the admin recovery-link path is robust under the live config.
- The 06-19/06-20/06-28 corrections (Karalea, Todd, Beau Skinner) are applied and visible.

## Priority map for the fix pass (agreed order)

1. Duplication at source: pass existing canonical context to incremental resolution passes,
   activate stable identity (resolver + alias seed), add a safe retirement path so re-derivation
   can converge, fix supersedeLosers to verify survivors, honor person_id in rename rewrites.
2. Run observability/self-healing: heartbeat + stage on miner_runs, stalled detection at read time,
   heartbeat-based reclaim (fixes both the zombie hang and the 20min<22min live-reclaim bug),
   zombie-immune auto-run measure, stop /building auto-firing mines.
3. Real mines off the 300s path: offload work-heavy runs (full recompute, big folds) to the Action;
   corrections-aware triggering so filed corrections actually cause a mine.
4. Ingest: idempotent capture writes + pending submit state, size cap, a capture-exclusion
   mechanism honored by the miner (the retraction path that append-only tables permit).
5. Recovery/onboarding: root-landing recovery catch, honest self-service reset, onboarding
   disconnect surfacing + skip affordance, revoke-fix for unlinked accounts, unblock Todd.
6. One-time data repair (only after 1 lands): backup, collapse the clusters via the corrections
   mechanism, exclude the duplicate capture, de-dup insights via a converging full rebuild, then a
   verification mine proving counts do not regrow.
