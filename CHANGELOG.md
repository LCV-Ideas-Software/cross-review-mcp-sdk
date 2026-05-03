# Changelog

All notable changes to this project will be documented here.

The format follows Keep a Changelog conventions. Public version display follows the organization
standard `v00.00.00`; npm package versions remain SemVer.

## [Unreleased]

_No entries yet._

## [v02.06.01] - 2026-05-03

**Hard budget gate replication for fallback + moderation-recovery paths (v2.6.1 backlog item from v2.5.0/v2.6.0 deferral).** Pre-v2.6.1 only the format-recovery branch refused paid recoveries that would breach `max_session_cost_usd`; the fallback and moderation-safe-retry branches still proceeded silently after their `cost_alert` events. v2.6.1 brings them in line: each branch now evaluates `priorRoundsCost + estimate > sessionCostLimit` BEFORE the paid call and surfaces a `peer.fallback.budget_blocked` / `peer.moderation_recovery.budget_blocked` event + `failure_class: budget_preflight` failure if the projected spend would exceed the limit.

### Added

- **Hard budget gate at the fallback path** in `orchestrator.ts:callPeerForReview`. The gate runs after `peer.fallback.cost_alert` and before `fallback.call(prompt, context)`. Returns a `budget_preflight` `PeerFailure` if the gate fires; the fallback iteration continues with the next configured fallback adapter (or terminates if none remain).
- **Hard budget gate at the moderation-recovery path** in `orchestrator.ts:callPeerForReview`. Mirrors the fallback gate but uses the moderation-safe prompt for the estimate (smaller than the original prompt because `buildModerationSafeReviewPrompt` caps the draft at 16 KiB instead of the full `max_draft_chars`).
- **`format_recovery_hard_budget_gate_test` smoke marker** (deferred from v2.5.0 / v2.6.0 — finally landed). Uses a 15 KiB filler draft to make `recoveryEstimate ≈ preflightEstimate`, so the actual first-call cost (input × rate, no amplification) suffices to push `prior + first_call + recoveryEstimate` past the limit while preflight still passes. Verifies `peer.format_recovery.budget_blocked` event fires + `failure_class: budget_preflight` failure is recorded.

### Behavioral change (operator-visible)

- Sessions running close to `max_session_cost_usd` may now see fallback or moderation retries refused with `failure_class: budget_preflight` instead of silently overrunning. Sessions with adequate budget see no change. Operators monitoring `events.ndjson` will see new `peer.fallback.budget_blocked` and `peer.moderation_recovery.budget_blocked` event types when the gate fires.

### Validation

- **`npm run build`** clean.
- **`npm run format:check`** clean.
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with 17 PASS markers (16 carry-over from v2.6.0 + 1 new: `format_recovery_hard_budget_gate_test`).
- **Cross-review-v2 trilateral session `f7c6b8b6-9f0f-4f80-b5e2-6686c709b9a7`** caller=claude, peers=codex+gemini+deepseek, 3 rounds. Outcome: gemini READY (verified, 3×), deepseek READY (verified, 3×), codex NEEDS_EVIDENCE (3×). Codex's residual is a meta-channel/evidence-packaging concern (acknowledged in R3 that the fallback-id symmetry argument is plausible; under-proves the moderation smoke-gap because moderationSafePrompt size depends on more than just the draft cap). Operator escalation chose **path A** (same as v2.5.0/v2.6.0 ships): ship with codex residual documented, v2.6.2 backlog tracks any post-commit refinements. Majority-verified READY (caller + 2/3 peers).

### Smoke coverage gap (intentionally documented)

- `peer.fallback.budget_blocked` and `peer.moderation_recovery.budget_blocked` smoke markers are NOT included. These two gates use the same arithmetic shape as preflight (`prior + estimate > limit`, same limit from `budgetLimit(config)`, same per-call estimate because prompt and adapter are identical), so the budget window where preflight passes AND the gate fires is mathematically empty in stub-driven smoke. The format-recovery gate is testable because it adds the already-incurred `currentPeerFirstCallCost`; fallback and moderation gates run BEFORE any peer-side cost is recorded. The gates are exercised in production where prior session totals accumulate over multiple rounds and actual provider costs vary from preflight estimates. Code review of `orchestrator.ts:callPeerForReview` validates the gate logic.

### Deferred to v2.7+ (architectural, unchanged)

- **Evidence Broker** (Codex+Gemini #1).
- **Per-provider health dashboard** (Codex+Gemini).

## [v02.06.00] - 2026-05-03

**Token-delta event compaction (Codex+Gemini audit, item A) + bundled v2.5.0 format hotfix.** Empirical measurement of 253 historical sessions surfaced 96 282 of 98 664 events (97.6%) as `peer.token.delta` — by far the dominant noise in `events.ndjson` files. v2.6.0 coalesces streaming token deltas in the adapter layer before emitting the event, dramatically reducing event-log volume without changing the total content streamed. Same release also bundles the prettier format fix that was reported as the v2.5.0 CI #31 failure (format-only, no functional impact).

### Added

- **`TokenEventBuffer` class in `peers/base.ts`.** Coalesces deltas before emit. Flushes either when the buffered length crosses the byte threshold (default 1024 chars) OR when time-since-last-flush crosses the ms threshold (default 250 ms), whichever fires first. `complete()` flushes the remainder and emits `peer.token.completed`.
- **`createTokenEventBuffer()` factory on `BasePeerAdapter`.** Each adapter call constructs the buffer once and uses `tokenStream.append(delta)` per chunk + `tokenStream.complete(text.length)` at end, replacing direct `emitTokenDelta` / `emitTokenCompleted` calls.
- **Verbose escape hatch `CROSS_REVIEW_V2_TOKEN_DELTA_VERBOSE=1`.** When set, every chunk emits immediately (legacy v2.5.x chunk-level behavior). Useful for operators who want maximum token-stream observability.
- **Two env knobs**: `CROSS_REVIEW_V2_TOKEN_DELTA_BYTES_THRESHOLD` (default 1024) and `CROSS_REVIEW_V2_TOKEN_DELTA_MS_THRESHOLD` (default 250) for tuning the coalesce thresholds without rebuild.

### Fixed

- **Prettier format on v2.5.0 files.** `CHANGELOG.md`, `scripts/smoke.ts`, and `src/core/orchestrator.ts` failed `npm run format:check` on v2.5.0 commit `cd0f040` (CI run #25283189042). Reformatted via `npm run format`. No functional changes.

### Migrated

- All 5 streaming adapters (`stub`, `openai`, `anthropic`, `gemini`, `deepseek`) — both the `call()` and `generate()` paths — now use `TokenEventBuffer` instead of direct `emitTokenDelta`/`emitTokenCompleted`. The legacy methods stay as primitives that the buffer flushes through.

### Behavioral change (operator-visible)

- Default-mode sessions emit ~10-20× fewer `peer.token.delta` events. A 50-chunk response that previously fired 50 events will fire ~3-5 coalesced events with the same total `chars` reported. Set `CROSS_REVIEW_V2_TOKEN_DELTA_VERBOSE=1` to restore legacy granularity.

### Validation

- **`npm run build`** clean.
- **`npm run format:check`** clean (the v2.5.0 CI failure is now resolved).
- **`npm run lint`** clean.
- **`npm run smoke`** EXIT=0 with 16 PASS markers (13 carry-over + 3 new): `token_delta_event_compaction_test` verifies that 50 32-char chunks produce <50 delta events in default mode and exactly 50 in verbose mode; `token_delta_stall_timer_test` proves the setTimeout-based flush fires during stream stalls (Gemini R1 fix); `token_delta_complete_try_finally_test` proves `complete()` emits `peer.token.completed` even if final `flushDelta` throws (Codex R1 fix).
- **Cross-review-v2 trilateral session `cc0a5fff-7e72-4daf-91c9-08079c269f64`** caller=claude, peers=codex+gemini+deepseek, 5 rounds, total cost ~$0.50 USD. Outcome: **converged unanimous_ready** (all 4 parties READY). R1 surfaced 2 real bugs that I fixed in v2.6.0 itself: Gemini caught the missing setTimeout for time-based flush during stream stalls; Codex caught the missing try/finally in `complete()`. R2-R5 closed evidentiary gaps for codex on the bundled prettier hotfix (literal full diff finally satisfied).

### Deferred to v2.6.1+ (carried from v2.5.1 backlog)

- Hard budget gate replication for fallback + moderation-recovery paths.
- Smoke marker for `peer.format_recovery.budget_blocked` (stub `output_tokens=text.length` arithmetic prevents a clean budget window — needs a unit-test fixture).
- Post-commit inspectable artifact for codex re-review of v2.5.0/v2.6.0 changes.

### Deferred to v2.7+ (architectural)

- **Evidence Broker** (Codex+Gemini #1): translate peer NEEDS_EVIDENCE asks into a structured per-round checklist that the next prompt explicitly addresses. Major design (changes session schema + prompt builders + status-parser).
- **Per-provider health dashboard** (Codex+Gemini): READY rate, NEEDS_EVIDENCE rate, average cost, parser warnings per provider.

## [v02.05.00] - 2026-05-03

**Operator-driven evidence-and-budget hardening pass + Codex/Gemini empirical-audit fold-ins.** Empirical analysis of 253 historical sessions (Codex audit 2026-05-03) surfaced concrete, measurable gaps that this release closes. Operator authorized a scope of 4 originals + 3 Codex fixes + 1 Gemini fix + 1 env knob; all shipped together with smoke coverage.

### Added

- **Differentiated per-field caps in `core/status.ts`.** `MAX_FIELD_LENGTH = 800` was tripping mostly on `summary` (verbose verdicts) while `evidence_sources` was rarely used at all. Replaced with `MAX_SUMMARY_LENGTH=800` (kept), `MAX_EVIDENCE_LENGTH=2500`, `MAX_REQUEST_LENGTH=1500`. Schema, parser truncation warnings, and `statusInstruction()` directive all use the per-field cap.
- **Session-start contract directive helper `sessionContractDirectives()` in `core/orchestrator.ts`.** Four mandatory rules injected into every caller/peer prompt builder (review, moderation-safe, revision, initial-draft): (1) R1 evidence-upfront — caller drafts must embed concrete evidence (file paths with line numbers, grep output, diff hunks, MD5 hashes, log excerpts) inline; (2) anti-verbosity (Claude named explicitly — historical worst offender for summary truncation in the corpus); (3) compactness symmetry — caller drafts obey the same compactness budget peers do; (4) caller finalize obligation — invoke `session_finalize` immediately on unanimous READY. Resolves the 22 in-progress orphan sessions Codex measured in the corpus.
- **`statusInstruction()` rewrite.** Now surfaces the per-field budget guidance ("summary SHORT 800 chars; detail belongs in evidence_sources up to 2500 chars; caller_requests/follow_ups up to 1500 chars each") and a Claude-named anti-verbosity rule.
- **`SessionStore.abortStaleSessions()`** companion to `clearStaleInFlight()`. Walks `outcome === undefined` sessions whose `updated_at` is older than the threshold (default 24h via `CROSS_REVIEW_V2_STALE_HOURS`), skips active in-flight or live-lock sessions, marks `outcome=aborted` + `outcome_reason=stale_no_finalize_<hours>h`. Wired into `mcp/server.ts` boot path next to the in-flight sweep.
- **`CROSS_REVIEW_V2_DEFAULT_MAX_ROUNDS` env var** (default 8). `config.budget.default_max_rounds` replaces the hardcoded 8 in `runUntilUnanimous`. The MCP zod schema still caps caller-supplied values at 32.
- **Auto-grant +1 round logic in `runUntilUnanimous`.** When a session reaches its ceiling with caller READY + every peer in `{READY, NEEDS_EVIDENCE}` + zero NOT_READY/rejected, the orchestrator grants one extra round so the caller can address the evidence asks. `AUTO_GRANT_CEILING = 2` and a deterministic `blockerFingerprint(peers)` (NEEDS_EVIDENCE peers + sorted `caller_requests`) prevent successive grants on the same asks. Emits `session.auto_round_granted` and `session.auto_round_skipped`. Targets the 22 max-rounds aborts Codex measured in the corpus.
- **`peer.fallback.cost_alert` and `peer.moderation_recovery.cost_alert` events.** Pre-v2.5.0 only `peer.format_recovery.cost_alert` notified FinOps consumers about paid recoveries; the fallback and moderation-safe paths were silent. Codex measured 11 `format_recovery.started` events with only 2 cost-alert siblings — the fallback/moderation paths skewed the ratio. Both events now mirror the format-recovery shape with `estimated_extra_cost_usd`.
- **Hard budget gate at format-recovery.** Pre-v2.5.0 `peer.format_recovery.cost_alert` was advisory; the paid recovery proceeded even when `current_session_cost + estimated_extra > max_session_cost_usd`. Now the orchestrator refuses the recovery, marks the peer with `failure_class: budget_preflight`, and emits `peer.format_recovery.budget_blocked` with structured cost data.

### Fixed

- **Stub adapters no longer attribute real currency.** Codex measured `US$ 39,255` of phantom spend by stubs in the 253-session corpus (`source: "stub"` was missing; cost rates were applied to character-count tokens). `peers/stub.ts` now overrides every `PeerResult.cost` and `GenerationResult.cost` with a canonical zero-cost estimate tagged `source: "stub"` (added to the `CostEstimate.source` enum in `core/types.ts`). Token usage is preserved for telemetry. A test-only escape hatch `CROSS_REVIEW_V2_STUB_FORCE_REAL_COST=1` lets smoke validate `budget_exceeded` enforcement.
- **Convergence reason surfaces per-peer `failure_class`.** The legacy `"one or more peers failed or did not respond"` (47 occurrences in the corpus, every one equally unactionable) is replaced with `"peers failed or did not respond: claude:network, gemini:rate_limit, codex:missing"`. The reason field stays a single string; granularity comes from enumerating peer + failure_class for every contributor.
- **Stub `generate()` propagates FORCE\_\* test markers.** Pre-v2.5.0 the stub passed a 1200-char slice of the prompt as the synthetic body. The v2.5.0 contract directive injection lengthened the prompt header beyond the 1200-char window, breaking multi-round smoke tests that rely on FORCE\_\* marker continuity (e.g. budget-exceeded driving claude with FORCE_NOT_READY across 3 rounds). Fixed by detecting carried markers in the input prompt and prefixing them to the generated body.

### Behavioral changes (operator-visible)

- Auto-grant changes the practical max-rounds ceiling from `default_max_rounds` (default 8) to `default_max_rounds + AUTO_GRANT_CEILING` (default 10) for sessions that would converge with one more revision round. The grant gate is restricted to caller-READY + only-NEEDS_EVIDENCE blockers; repeat-blocker fingerprint prevents pathological spending. Sessions with NOT_READY peers or rejected peers see no behavior change.
- Format-recovery hard budget gate converts a previously-advisory cost alert into a session-blocking decision when the next paid recovery would arithmetically breach `max_session_cost_usd`. Sessions with adequate budget see no change; sessions running close to the cap may now surface `failure_class: budget_preflight` instead of silently overrunning.
- Smoke unconditionally overrides `CROSS_REVIEW_V2_DATA_DIR` to a fresh `os.tmpdir()` path even when the operator sets the env var. This was previously honored via a `||` fallback, but operators who set it to point at the live runtime directory (`~/.cross-review/data` etc.) saw smoke pollute their session history AND inherit stale orphan sessions that broke deterministic assertions. Documented in the smoke header.

### Validation

- **`npm run build`** clean (TypeScript 6.0.3, exit 0).
- **`npm run smoke`** EXIT=0 with 13 PASS markers, 9 of them new for v2.5.0:
  - `summary_cap_differentiation_test`
  - `session_contract_directives_test`
  - `default_max_rounds_env_honored_test`
  - `stale_session_aborted_24h_test`
  - `stale_session_skipped_when_running_test`
  - `stub_zero_cost_test`
  - `convergence_structured_failure_reason_test`
  - `auto_grant_evidence_only_then_skipped_repeat_test`
  - `auto_grant_blocked_by_not_ready_test`
- **`npm run lint`** clean (eslint . --max-warnings=0).
- **Cross-review-v2 trilateral session `5419e29a-7d99-4c49-99c5-1b28316a9071`** caller=claude, peers=codex+gemini+deepseek, 4 rounds. Outcome: gemini READY (verified, 4×), deepseek READY (verified, 3×), codex NEEDS_EVIDENCE (4×). Codex's residual was a meta-channel limit — the full 60 KB diff exceeded the MCP message budget once protocol overhead was factored in, so codex could not independently verify the diff line-by-line despite each round's increasingly detailed code excerpts (R3 inlined the bug-fix diff for the format-recovery cost gate; R4 inlined orchestrator.ts:1058-1172 verbatim). Operator escalation chose path A: ship with codex's residual documented and a v2.5.1 follow-up to provide a post-commit inspectable artifact (commit hash + per-file split-diff) for codex re-review. This release is therefore majority-verified READY (caller + 2/3 peers) with a known structural blocker rather than a code blocker.

### Deferred to v2.5.1 (small follow-ups)

- **Hard budget gate also for fallback and moderation-recovery paths.** v2.5.0 only gates format-recovery (the most common chargeable retry); replicating the same `current_session_cost + estimated_extra > limit` check at the fallback and moderation-recovery sites is a small, self-contained follow-up that fits a patch release.
- **Smoke marker for `peer.format_recovery.budget_blocked`.** The format-recovery hard-budget gate is exercised by code path inspection (orchestrator.ts:1095-1140) and TypeScript compilation, not by a dedicated stub-driven smoke marker in v2.5.0. Reason: stub `output_tokens=text.length` (~80 chars) is much smaller than `max_output_tokens` (default 20K), so estimatedPeerRoundCost over-estimates relative to actual cost and there is no clean budget window where preflight passes but the gate fires deterministically without flake-prone arithmetic. v2.5.1 will introduce a shared harness that covers the gate at all three retry sites with the budget tuning resolved.

### Deferred to v2.6+ (architectural)

- **Token-delta event compaction.** 96 282 of 98 664 events in the 253-session corpus are `peer.token.delta`. Operators can opt out via `CROSS_REVIEW_V2_STREAM_TOKENS=0` today; an architectural buffered-emit refactor is deferred.
- **Evidence Broker** (Codex audit recommendation #1): translate peer NEEDS_EVIDENCE asks into a structured checklist for the next round; deferred as a major design.
- **Cost reconciliation peer×total.** Historical `meta.json` rows have `mergeCost(peer_costs) !== totals.cost.total_cost` drift; a migration pass is risky without versioned cost-algorithm tagging — deferred.
- **Provider-health dashboard.** New observability surface; deferred.
- **Two parallel directive sources.** `statusInstruction()` in `status.ts` and `sessionContractDirectives()` in `orchestrator.ts` both encode Claude-named anti-verbosity and per-field budget rules; not identical and at risk of drifting. Tech-debt note — extract a shared `peerProtocolRules.ts` later.

## [v02.04.01] - 2026-05-02

**CI hotfix for the v2.4.0 stub fail-fast gate.** The v2.4.0 P1.1 fix throws when `CROSS_REVIEW_V2_STUB=1` is set without confirmation. CI workflow `ci.yml` already passed `CROSS_REVIEW_V2_STUB=1` to the smoke step, but `mcp/server.ts` had a top-level `main().catch(...)` that ran on every module import — including the smoke harness's `import { SessionIdSchema, pruneCompletedJobs } from "../src/mcp/server.js"`. In CI, that import-time `main()` saw STUB=1 without confirmation (because confirmation is only set inside `scripts/smoke.ts`'s body, after ESM imports resolve) and tripped the gate. Locally the test passed only because the host env did not pre-set STUB.

### Fixed

- **`mcp/server.ts` top-level `main()` guard.** `main()` now runs only when the module is invoked as the entry point (canonical ESM `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])` check). Importing named exports (`SessionIdSchema`, `pruneCompletedJobs`, `JobStatus`) no longer triggers a server boot, so the smoke harness can validate the schema without spinning up a real orchestrator.
- **`.github/workflows/ci.yml` + `publish.yml`.** Belt-and-suspenders: both workflows now also set `CROSS_REVIEW_V2_STUB_CONFIRMED: "1"` alongside `CROSS_REVIEW_V2_STUB: "1"` so the gate is satisfied even if a future change reintroduces import-time side effects.

### Validation

- `CROSS_REVIEW_V2_STUB=1 npm run smoke` (reproducing the CI failure scenario without the confirmation flag) — EXIT=0 GREEN with all four `[smoke]` markers PASS.
- `CROSS_REVIEW_V2_STUB=1 CROSS_REVIEW_V2_STUB_CONFIRMED=1 npm test` — EXIT=0 GREEN.

## [v02.04.00] - 2026-05-02

**Audit-closure hardening pass.** Closes 18 priorities + 5 misc items from the internal v2.3.3 technical opinion audit. Mirrors the v1 v1.6.7 cycle. Additive within the v2.x public surface plus three behavioral changes flagged below.

### Added

- **`STREAM_TEXT_MAX_BYTES = 16 MiB` per peer call.** Anthropic, OpenAI, Gemini and DeepSeek streaming buffers now reject responses that exceed the cap before the SDK materializes the final message. The retry layer classifies the overflow as a regular failure so the caller observes a structured rejection instead of an OOM.
- **`StreamBuffer` class in `peers/base.ts`** with O(1) per-append byte accounting (running counter; never re-scans the accumulated buffer). Refined after cross-review-v2 R3 caught an O(N²) regression in the initial `appendStreamText` shim. The shim is preserved for stateless callers but production adapters use the class form.
- **`SessionStore.sweepOrphanTmpFiles()`** removes `*.<pid>.<ts>.<nonce>.tmp` artifacts left behind by interrupted writes (P1.3 companion).
- **`SessionStore.clearStaleInFlight()`** clears `meta.in_flight` when the lock holder PID is dead OR `started_at > 30 min`. Wired into `mcp/server.ts` boot path alongside `sweepOrphanTmpFiles`.
- **MCP tool schema caps.** `task` (32 KiB), `draft` (200 KiB), `initial_draft` (200 KiB) now declare `.max()` so oversized inputs are rejected at the schema layer before the parser/spawn/persistence layers touch them.
- **`MAX_PAYLOAD_BYTES = 64 KiB` byte-level guard before `JSON.parse`** in `core/status.ts`. Hostile peers can no longer OOM the orchestrator with a giant `<cross_review_status>` block.
- **Retry-After header extraction.** `errors.ts` now reads `Retry-After` from `error.headers` (fetch shape) and `error.response.headers` (legacy shape) and populates `failure.retry_after_ms`. The retry loop already consumes that field.
- **5xx gateway errors are retryable.** 502/503/504 transient gateway responses are no longer collapsed into the generic `provider_error` non-retryable class.
- **`AbortSignal` propagation in Gemini.** Both `call()` and `generate()` now pass `context.signal` to the GoogleGenAI SDK, so `session_cancel_job` can interrupt in-flight Gemini requests instead of waiting for the natural response.
- **Boot stub double-confirmation (fail-fast).** `CROSS_REVIEW_V2_STUB=1` alone now THROWS at startup; activation requires `NODE_ENV=test` OR `CROSS_REVIEW_V2_STUB_CONFIRMED=1`. Guards production deploys against accidental stub activation via stray dotenv variables AND preserves operator intent — flag-only users (local dev, CI offline, budget kill) are NOT silently billed for real provider calls. Refined after cross-review-v2 R1 caught a financial-safety regression in the initial fallback design.
- **`SECURITY.md` Threat Model section.** Documents the single-user trusted-host assumption, multi-host concurrency caveats, dashboard binding, stub safety, schema caps, streaming caps and `OPENAI_BASE_URL` precedence.
- **Dashboard CSP + clickjacking headers.** The HTML response now ships `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- **Format-recovery quota.** Per-session cap of 6 recoveries; subsequent peer parser failures report `failure_class: "format_recovery_exhausted"` instead of triggering more paid recovery calls.

### Fixed

- **`atomicWriteFile` retry on Windows.** Pre-v2.4.0 `fs.renameSync` failures with `EPERM`/`EACCES`/`EBUSY`/`EEXIST` left orphan `.tmp` files in the session directory. v2.4.0 retries with backoff (10/20/40/80/160 ms × 5), adds a `crypto.randomBytes(2)` nonce to the tmp filename, and unlinks the tmp on terminal failure. Mirrors v1 v1.6.7 P1.2.
- **`JSON.parse` failures now contextualized.** `readJson()` wraps parse errors with the source file path so audit consumers see WHICH file is malformed instead of a bare `SyntaxError`.
- **`SessionIdSchema` lowercase normalization.** UUIDv4 regex was already case-insensitive but zod did not normalize the output. v2.4.0 transforms to lowercase before downstream consumers see the value, eliminating the TOCTOU surface on case-sensitive filesystems.
- **`CROSS_REVIEW_V2_DATA_DIR` tilde expansion.** `~`, `~/...` and `~\...` are now expanded to `os.homedir()` before `path.resolve()`.
- **Retry backoff jitter.** `retry.ts` now applies full jitter (random in [0, capped]) to the exponential backoff so concurrent peers hitting the same provider do not synchronize their retries (thundering herd).
- **Convergence strict equality.** `p.status == null` (loose) replaced with `=== null || === undefined` so a future code path producing `""` or `0` would not be misclassified as `NEEDS_EVIDENCE`.
- **Model-selection nullish coalescing.** `config.models[peer] || PRIORITY[peer][0]` replaced with `??` so an explicit `null` fallback is preserved.
- **`appendEvent` in-memory monotonic seq counter.** Pre-v2.4.0 `seq` was recomputed by reading + counting the events file inside the session lock; the counter is now cached per session_id and incremented strictly monotonically. Restart re-initializes from disk.
- **`redact()` env-style assignments.** Patterns like `PASSWORD=value`, `API_KEY: token`, `Authorization: Bearer ...` are now redacted while preserving the key name for audit observability.
- **Cost preflight includes retry/fallback amplification.** `estimatedPeerRoundCost` multiplies by `min(4, retry.max_attempts + len(fallback_models))` so the budget gate is conservative against the worst-case retry chain.
- **Model-selection env override validation.** Overrides outside the documented PRIORITY list are honored but flagged with `confidence: "inferred"` so a typo surfaces here instead of as a provider 404 mid-round.

### Behavioral changes (operator-visible)

- `CROSS_REVIEW_V2_STUB=1` alone now BOOTS WITH REAL ADAPTERS. Set `NODE_ENV=test` or `CROSS_REVIEW_V2_STUB_CONFIRMED=1` to opt in deliberately. Stderr prints a loud notice for both paths.
- `convergence_scope` enum unchanged (no new values introduced — equivalent to v1 v1.6.7 P2.6 wisdom that adding a new prefix would break enum-validating consumers).
- Session ids returned from MCP tools are always lowercase (case-insensitive UUIDs accepted, lowercase output).

### Validation

- `npm run format:check`
- `npm run lint`
- `npm test` (build + smoke + runtime-smoke).

### Pre-commit cross-review

- Cross-review-v2 quadrilateral session `13690e71-7205-4b46-837d-7da9091d89b6` converged READY after 6 rounds (caller=claude, peers=codex+gemini+deepseek). Codex (original v2 author) raised five successive rigorous blockers across R1–R5: financial-safety regression in initial stub gate (later flagged stronger by gemini), pre-allocation byte check ordering, seq cache durability, format-recovery concurrency, and finally an unconditional `markInFlight` overwrite that allowed concurrent same-session ask_peers to race the recovery counter. R5 added an explicit `if (meta.in_flight) throw` guard inside `markInFlight` and a `mark_in_flight_concurrency_guard_test` smoke marker. Final outcome: `unanimous_ready` with codex/gemini/deepseek READY and decision_quality clean across all three. New smoke markers visible in CI: `session_id_schema_lowercase_test: PASS`, `stream_buffer_overflow_test: PASS`, `seq_cache_append_failure_restart_test: PASS`, `mark_in_flight_concurrency_guard_test: PASS`.

## [v02.03.03] - 2026-04-30

### Fixed

- `review_focus` is now wrapped in escaped `<review_focus>...</review_focus>` delimiters before prompt injection. The block explicitly states that tagged content is operator-provided scope data, not instructions that can override protocol, schemas, safety rules or task directives. This operationalizes the Gemini/Antigravity "Prompt Shielding" recommendation while keeping parity with `cross-review-v1`.
- Paid provider calls are now blocked until explicit financial controls are configured: session ceiling, preflight round ceiling, `until_stopped` ceiling when applicable, and per-peer USD-per-million input/output rate cards. Missing financial variables return `financial_controls_missing` before provider calls instead of relying on hard-coded cost fallbacks.
- `server_info` now reports `financial_controls.paid_calls_ready`, the missing financial variables, and the active policy so operators can diagnose cost-configuration blockers before starting a paid run.
- Hardened the MCP surface with UUIDv4-only session/job schemas, a 24-hour minimum idle floor for `session_sweep`, completed-job pruning, and `peer.format_recovery.cost_alert` events before automatic format-recovery or decision-retry calls.

### Validation

- `npm run format:check`
- `npm test` — covers `<review_focus>` tags, escaped attempted `</review_focus>` injection, redaction, bounding, the existing `OUT OF SCOPE` clause, UUIDv4-only session/job schemas, missing financial-control blocking, the configurable `until_stopped` cost ceiling, the 24-hour sweep floor, completed-job pruning, and format-recovery cost alerts.

## [v02.03.02] - 2026-04-30

### Fixed

- Reissued the README organizational standardization after applying the repository Prettier policy, so the latest release is also the first CI-green artifact after the standardization pass.
- `NOTICE` and `CODE_OF_CONDUCT.md` now use the stable `cross-review-v2` project name and current dependency framing, completing the active-document rename cleanup.

## [v02.03.01] - 2026-04-30

### Changed

- `README.md` now follows the shared organizational opening pattern adopted across the public repositories, while preserving the API-first runtime, model-selection, streaming, and observability sections specific to `cross-review-v2`.

## [v02.03.00] - 2026-04-30

### Added

- Added optional provider-neutral `review_focus` support to `session_init`, `ask_peers`, `session_start_round`, `run_until_unanimous` and `session_start_unanimous`.
- Persisted session-level focus as `meta.review_focus` plus `review-focus.md`, and injected it into initial generation, review, revision, moderation-safe retry, format recovery and decision-retry prompts as a bounded/redacted `Review Focus` block that strips accidental leading `/focus` prefixes.
- Added `CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS` so operators can tune the focus anchor length without changing source code.

### Changed

- Incorporated the community `/focus` suggestion as a cross-provider scope anchor instead of a Claude-specific slash command. Official Claude Code docs describe `/focus` as a focus-mode UI toggle, so `cross-review-v2` now uses explicit prompt context that applies equally to OpenAI/Codex, Anthropic/Claude, Gemini and DeepSeek.
- Front-loaded the `Review Focus` block before task/history material in generation, review, revision and retry prompts, and added an explicit `OUT OF SCOPE` rejection clause so reviewers do not turn unrelated findings into blockers.
- Promoted the release to minor because `review_focus` and `CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS` expand the public MCP/configuration surface without breaking existing callers.
- Aligned `auto-tag.yml` with the npm-production environment policy by creating lightweight release tags and dispatching `publish.yml` on the tag ref instead of `main`.
- Standardized publishing with `cross-review-v1`: `publish.yml` now uses separate gate, npmjs.com, GitHub Packages and GitHub Release jobs, with npm Trusted Publishing, `--provenance`, and an npm `>=11.5.1` gate.

### Validation

- `npm run format:check`
- `npm run lint`
- `npm test` — includes runtime smoke, redaction/truncation checks for `review_focus`, accidental `/focus` prefix stripping, front-loaded focus ordering, `OUT OF SCOPE` clause coverage, and retry-path coverage for format recovery and decision retry prompts.

## [v02.02.00] - 2026-04-30

### Added

- Added real provider token streaming across OpenAI, Anthropic, Gemini and DeepSeek adapters.
- Added count-based `peer.token.delta` and `peer.token.completed` session events so long-running reviews can expose live progress without waiting for full provider responses.
- Added `CROSS_REVIEW_V2_STREAM_TOKENS` and `runtime_capabilities.token_streaming` as the public runtime controls for token streaming.
- Added optional `CROSS_REVIEW_V2_STREAM_TEXT=1` for trusted local diagnostics that need redacted streamed text in session events.
- Added a real API streaming smoke script that verifies all four providers emit token events without printing prompts, responses or API keys.

### Changed

- Kept token streaming enabled by default while preserving the existing final-result parsing and unanimity gate.
- Kept token event text disabled by default so persisted `events.ndjson` progress events cannot leak sensitive strings split across provider chunks.
- Documented the provider-native streaming APIs used by each peer adapter and corrected the local MCP path examples to the stable `cross-review-v2` folder name.

## [v02.01.01] - 2026-04-30

### Fixed

- Removed the CodeQL `js/polynomial-redos` alert from secret redaction by replacing the private-key block regular expression with bounded delimiter scanning.
- Removed the CodeQL `js/log-injection` alert from the dashboard error path by avoiding user-controlled error text in the console log line.
- Added regression coverage for mismatched, unterminated, repeated and overlapping private-key markers so malformed PEM-like payloads remain safely redacted without reintroducing ReDoS risk.
- Added a full decision retry when a peer returns no usable review decision, preventing empty provider output from becoming a false `NEEDS_EVIDENCE` recovery.
- Added configurable `CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS` support and standardized the high output-token budget across OpenAI, Anthropic, Gemini and DeepSeek review/generation calls.
- Tightened model selection to advanced thinking-capable models only, removed weak/deprecated fallbacks, and enabled provider-specific thinking controls for Anthropic, Gemini and DeepSeek.
- Added smoke coverage proving weak/deprecated returned candidates do not trigger silent model downgrades, plus a redacted real-API capability report for the four provider keys.
- Raised the default Anthropic effort to `xhigh` for Claude Opus 4.7 adaptive-thinking review work.
- Removed residual public references to the temporary development package name after the stable `cross-review-v2` rename.

## [v02.01.00] - 2026-04-29

### Added

- Promoted the API-first implementation to the first stable release as `cross-review-v2`.
- Added cooperative background-job cancellation with `session_cancel_job`, durable cancellation metadata and provider `AbortSignal` forwarding where supported.
- Added `session_recover_interrupted` for restart recovery of stale in-flight sessions.
- Added `session_metrics` and `runtime_capabilities` tools for observability and host/tool discovery.
- Added configurable prompt compaction limits for verbose peer history and moderation-sensitive review rounds.
- Added conservative budget preflight checks before expensive review rounds when limits and rate cards are configured.
- Added per-peer fallback model lists with auditable fallback events.

### Changed

- Renamed active runtime, package, bin commands, public docs, Pages metadata and MCP server identity from the development name used before this release to `cross-review-v2`.
- Changed status badges and release documentation from alpha/prerelease to stable SemVer.
- Expanded session reports and dashboard contracts to include cancellation, recovery, metrics and fallback state.

### Fixed

- Prevented long-running background work from becoming opaque by exposing durable metrics, events, cancellation status and restart-recovery state.
- Reduced moderation failures caused by overly verbose peer history through bounded prompt summaries.

## [v02.00.04] - 2026-04-29

### Fixed

- Removed the CodeQL `js/file-system-race` alert in session event persistence by appending `events.ndjson` under the session lock instead of reading/appending through an unlocked race window.
- Bumped the SDK package/runtime version to `2.0.4-alpha.0`.

## [v02.00.03] - 2026-04-29

### Added

- Added background MCP tools `session_start_round`, `session_start_unanimous`, `session_poll`, `session_events` and `session_report` for long-running real API sessions.
- Added durable per-session `events.ndjson` and `session-report.md` artifacts.
- Added per-peer decision quality tracking in convergence results and reports.
- Added generation artifact accounting so lead-peer drafts and revisions contribute to session token/cost totals.
- Added configurable provider cost-rate env vars plus optional session budget guard.
- Added moderation-safe retry handling for provider prompt rejections caused by verbose or policy-sensitive peer history.

### Changed

- Compact prior peer history in follow-up prompts by using structured summaries and requested changes instead of replaying raw peer output.
- Expanded `run_until_unanimous` with `session_id`, `until_stopped` and `max_cost_usd`.
- Improved dashboard session cards and added session event/report APIs.
- Bumped the SDK package/runtime version to `2.0.3-alpha.0`.

### Fixed

- Persisted runtime events through the MCP server and dashboard event sinks instead of keeping them only in process logs.
- Made parser recovery failures explicit as `unparseable_after_recovery` blockers.

## [v02.00.02] - 2026-04-29

### Changed

- Normalized npmjs.com dist-tags so `latest` and the prerelease alias point to the newest published SDK package version.
- Replaced the SDK Pages sponsor landing with the organization-standard SumUp support page.

### Fixed

- Sanitized dashboard HTTP 500 responses so internal exception messages are logged server-side but never returned to clients, resolving CodeQL `js/stack-trace-exposure`.
- Bumped the SDK package/runtime version to `2.0.2-alpha.0`.

## [v02.00.01] - 2026-04-29

### Changed

- Enforced npmjs.com package access as public after publish and added an unauthenticated registry visibility check before the release workflow can pass.
- Aligned the repository funding metadata with the organization-wide Sponsors pattern and preserved that YAML style outside Prettier formatting.
- Normalized `repository.url` to npm's canonical `git+https://...git` form.
- Bumped the SDK package/runtime version to `2.0.1-alpha.0`.

## [v02.00.00] - 2026-04-29

### Added

- Added smoke coverage for parser recovery on overlong summaries, fenced JSON and invalid JSON with an unambiguous status key.
- Added automatic one-shot per-peer format recovery when a response has no parseable status.
- Added convergence metadata that distinguishes latest-round unanimity from recovered session-quorum unanimity.
- Added a shared 300s MCP request timeout constant and runtime smoke script so local MCP clients do not fail on the SDK default 60s timeout while real peers are still processing.

### Changed

- Activated automatic tag creation from `package.json` version on pushes to `main`.
- Activated GitHub release and package publishing for the development package line, using prerelease npm dist-tags such as `alpha` so alpha builds do not replace any stable `latest` channel.
- Aligned public version display and GitHub release tags with the organization `v00.00.00` standard while keeping npm SemVer for package publishing.
- Added a `prepack` clean build so local runtime data cannot leak into npm artifacts through stale `dist/` output.
- Hardened Git and npm ignore rules so `.env*`, `.tmp`/`tmp` and local runtime files are never published.
- Pointed the development homepage, MCP metadata and Pages site at the temporary development domain.
- Preserved the original expected quorum when a later recovery call reviews only a subset of peers.
- Clarified peer response-format instructions so models do not treat the schema itself as the artifact under review.
- Documented the distinction between MCP client request timeout and provider HTTP timeout.

### Fixed

- Fixed false non-convergence when a peer returned a valid status with `summary` or list fields larger than the strict schema limit; the parser now normalizes recoverable fields and keeps warnings in the audit trail.

## [v2.0.0-alpha.2] - 2026-04-28

### Added

- Added durable `in_flight`, `convergence_scope` and `convergence_health` metadata so interrupted sessions can be inspected and swept more safely.
- Added `session_attach_evidence`, `escalate_to_operator` and `session_sweep` MCP tools.
- Added `session_check_convergence` for read-only inspection of the latest convergence state.
- Added formal `silent_model_downgrade` failures when a provider returns a different model than the requested one.
- Added smoke coverage for evidence attachment, operator escalation and idle-session sweep.

### Changed

- Session rounds now clear in-flight state and update convergence health when they complete.
- Idle sweeps mark unfinished stale sessions with explicit outcome and health metadata.

## [v2.0.0-alpha.1] - 2026-04-28

### Added

- Added reported-model tracking for generation and review calls, with convergence blocked when a provider silently returns a different model.
- Added per-session failed-attempt aggregation in `meta.json`.
- Added contextual recovery hints for rate-limit and moderation failures.

### Changed

- Made session writes atomic and protected round/finalization updates with a local session lock.
- Hardened session path handling with strict UUID v4 validation and containment checks.
- Changed Gemini and DeepSeek probes to model-listing calls instead of paid generation calls.
- Prevented the lead peer from reviewing its own generated draft by default.
- Moved internal peer-exchange prompts to English technical wording.
- Expanded redaction coverage for API keys, tokens, JWTs, bearer credentials and private-key blocks.

### Fixed

- Fixed the OpenAI model probe call that used an invalid `limit` argument cast.
- Fixed stale adapter state after runtime model discovery.
- Tightened 429, authentication and moderation error classification to avoid false rate-limit reports.
- Fixed stale session metadata on converged `ask_peers` results.

## [v2.0.0-alpha.0] - 2026-04-28

### Added

- Initial API/SDK-only cross-review MCP server.
- Official SDK adapters for OpenAI, Anthropic, Google Gemini and DeepSeek.
- Runtime model discovery and documented best-model selection.
- Durable local session store with prompts, drafts, peer responses, failures and final artifacts.
- Strict unanimity gate across all selected peers.
- Local dashboard for session inspection.
- GitHub-ready workflows for CI, Pages, releases, packages and Dependabot automerge.
- Public-repo security baseline with secrets ignored and CodeQL Default Setup documented.
