# Changelog

All notable changes to this project will be documented here.

The format follows Keep a Changelog conventions. Public version display follows the organization
standard `v00.00.00`; npm package versions remain SemVer.

## [Unreleased]

## [v02.00.00] - 2026-04-29

### Added

- Added smoke coverage for parser recovery on overlong summaries, fenced JSON and invalid JSON with an unambiguous status key.
- Added automatic one-shot per-peer format recovery when a response has no parseable status.
- Added convergence metadata that distinguishes latest-round unanimity from recovered session-quorum unanimity.
- Added a shared 300s MCP request timeout constant and runtime smoke script so local MCP clients do not fail on the SDK default 60s timeout while real peers are still processing.

### Changed

- Activated automatic tag creation from `package.json` version on pushes to `main`.
- Activated GitHub release and package publishing for SDK tags under `@lcv-ideas-software/cross-review-mcp-sdk`, using prerelease npm dist-tags such as `alpha` so SDK alpha builds do not replace any stable `latest` channel.
- Aligned public version display and GitHub release tags with the organization `v00.00.00` standard while keeping npm SemVer for package publishing.
- Added a `prepack` clean build so local runtime data cannot leak into npm artifacts through stale `dist/` output.
- Hardened Git and npm ignore rules so `.env*`, `.tmp`/`tmp` and local runtime files are never published.
- Pointed the SDK homepage, MCP metadata and Pages site at `cross-review-mcp-sdk.lcv.app.br`.
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
