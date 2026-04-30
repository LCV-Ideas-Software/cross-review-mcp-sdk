# Changelog

All notable changes to this project will be documented here.

The format follows Keep a Changelog conventions. Public version display follows the organization
standard `v00.00.00`; npm package versions remain SemVer.

## [Unreleased]

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
