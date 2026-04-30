<p align="center">
  <img src=".github/assets/lcv-ideas-software-logo.svg" alt="LCV Ideas & Software" width="520" />
</p>

# cross-review-v2

> MCP server orchestrating API-first cross-review between Claude, ChatGPT Codex, Gemini, and DeepSeek with unanimous convergence gates.

[![status: stable](https://img.shields.io/badge/status-stable-brightgreen.svg)](#status)
[![npm](https://img.shields.io/npm/v/@lcv-ideas-software/cross-review-v2.svg)](https://www.npmjs.com/package/@lcv-ideas-software/cross-review-v2)
[![runtime: API-only](https://img.shields.io/badge/runtime-API--only-blue.svg)](#what-it-does)
[![security: CodeQL Default Setup](https://img.shields.io/badge/security-CodeQL%20Default%20Setup-informational.svg)](#security)
[![license: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green.svg)](./LICENSE)

**Install.** `npm install -g @lcv-ideas-software/cross-review-v2` (npmjs.com) or `npm install -g @lcv-ideas-software/cross-review-v2 --registry=https://npm.pkg.github.com` (GitHub Packages mirror).

**Status.** Stable. Current release: **v02.03.01** (npm package `2.3.1`) paired with an API-first stable public surface. See [CHANGELOG.md](./CHANGELOG.md) for the release history. v2.x releases use the organization display-tag standard (`v00.00.00`) while npm packages keep SemVer (`2.x.y`). The stable public rename from the temporary development name was completed at **v02.01.00** / npm package `2.1.0`, and all active docs, package metadata, publishing workflows, and runtime identity now use `cross-review-v2`.

The version history at a glance:

| Release | Scope |
|---|---|
| **`v02.03.01`** | **README organizational standardization.** Harmonized the public README opening with the shared organizational pattern, preserving the API-first operational sections while aligning badges, status framing, and version-history presentation. |
| **`v02.03.00`** | **Review focus tightening.** Added provider-neutral `review_focus` across the main orchestration tools, front-loaded it in prompts, stripped accidental `/focus` prefixes, and introduced explicit `OUT OF SCOPE` guidance so reviewers stay anchored without hiding critical blockers. |
| **`v02.02.00`** | **Live token streaming.** Added real provider token streaming, count-based progress events, `CROSS_REVIEW_V2_STREAM_TOKENS`, optional redacted streamed text for trusted diagnostics, and a real API streaming smoke. |
| **`v02.01.01`** | **Hardening and advanced-model enforcement.** Closed CodeQL issues in redaction/logging, added decision-retry recovery, standardized `CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS`, removed weak/deprecated model fallbacks, and enforced advanced thinking-capable peer selection. |
| **`v02.01.00`** | **First stable release as cross-review-v2.** Promoted the API-first implementation to stable, added cancellation, restart recovery, metrics, runtime capabilities, fallback events, and completed the public rename to `cross-review-v2`. |
| **`v2.0.x`** | **Foundation hardening before stability.** The pre-stable `v02.00.xx` line built the durable session model, dashboard/reporting surface, provider adapters, retry behavior, and release/publishing baseline that enabled the stable cut. |

## What It Does

`cross-review-v2` is the stable API-first implementation of the cross-review pattern. It does not execute Claude CLI, Codex CLI, Gemini CLI, DeepSeek CLI, PowerShell shells, or terminal sessions. The peers are called through provider APIs and official client libraries:

- OpenAI client library for the Codex/OpenAI peer.
- Anthropic TypeScript client library for Claude.
- Google Gen AI client library for Gemini.
- OpenAI-compatible DeepSeek API through the OpenAI client library.

Runtime calls are real provider calls by default. Stubs exist only for smoke tests and CI when `CROSS_REVIEW_V2_STUB=1`.

## Topology

`cross-review-v2` is MCP stdio on the outside and provider-API orchestration on the inside. The caller host opens a durable session, the server fans out to the four peers through official APIs, and convergence is granted only when the unanimity gate is satisfied.

## Peers and Transport

| Peer | Transport | Notes |
|---|---|---|
| `codex` | OpenAI API via official client library | Advanced reasoning model selection with explicit reasoning effort controls. |
| `claude` | Anthropic API via official TypeScript SDK | Advanced Opus-class selection with adaptive thinking. |
| `gemini` | Google Gen AI SDK | Advanced Gemini 3.1 Pro preview selection with thinking-capable preference. |
| `deepseek` | DeepSeek OpenAI-compatible API via OpenAI client library | Advanced `deepseek-v4-pro` selection with reasoning effort controls. |

## Rename Notice

Starting with stable version `2.1.0`, this project is named `cross-review-v2`. The previous development name is retained only in historical changelog and memory notes.

## Secrets

API keys are read only from Windows environment variables. This project does not save API keys in JSON, `.env`, logs, session files, or prompts.

PowerShell examples:

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<OPENAI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<ANTHROPIC_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "<GEMINI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "<DEEPSEEK_API_KEY>", "User")
```

Restart the terminal or application after changing Windows environment variables.

## Model Selection

At startup/session initialization, the server queries provider model APIs when keys are present and selects the highest-capability model available to that key according to documented provider priorities.

Current documented priority defaults:

- OpenAI/Codex: `gpt-5.5` with `CROSS_REVIEW_OPENAI_REASONING_EFFORT=xhigh`.
- Anthropic/Claude: `claude-opus-4-7` with adaptive thinking and `CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT=xhigh`.
- Google/Gemini: `gemini-3.1-pro-preview`.
- DeepSeek: `deepseek-v4-pro`.

Cross-review requires advanced thinking/reasoning-capable models. Model priority lists must not include provider models that are known to lack thinking support, low-capacity models that are unsuitable for peer review, or models marked for deprecation in official provider documentation. If no advanced priority model is available to a key, the runtime keeps the documented advanced fallback so the problem is visible instead of silently downgrading.

Explicit env var overrides always win:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-opus-4-7", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_MODEL", "gemini-3.1-pro-preview", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_MODEL", "deepseek-v4-pro", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_REASONING_EFFORT", "max", "User")
```

Optional fallback model lists are comma-separated:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_FALLBACK_MODELS", "gpt-5.4,gpt-5.3", "User")
```

Each probe records the selected model, candidates returned by the API, source URL, confidence and selection reason.

## Output Token Budget

`CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS` controls the maximum output budget sent to all peer providers. The same value is applied to OpenAI, Anthropic, Gemini and DeepSeek for review calls and generation calls.

Default: `20000`.

Set it in the MCP host configuration when you want the limit to travel with that MCP server entry:

```toml
[mcp_servers.cross-review-v2]
tool_timeout_sec = 1800
command = "C:/Users/leona/AppData/Roaming/npm/cross-review-v2.cmd"
args = []
env_vars = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]
env = { CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS = "20000" }
```

You can also set it as a Windows environment variable:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS", "20000", "User")
```

Invalid, zero or negative values are ignored and the runtime falls back to `20000`.

`CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS` controls the maximum length of the optional `review_focus` prompt block. Default: `2000`.

## Token Streaming

Token streaming is enabled by default. Provider progress is written to the session event stream as `peer.token.delta` events with character counts, followed by one `peer.token.completed` event per peer call. This lets MCP hosts, dashboards and future UIs show long-running work as it happens instead of waiting for the complete provider response.

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_STREAM_TOKENS", "1", "User")
```

Disable token streaming only if a host cannot consume frequent session events:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_STREAM_TOKENS", "0", "User")
```

For safety, streamed event text is not included by default. Enable it only for trusted local diagnostics:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_STREAM_TEXT", "1", "User")
```

When `CROSS_REVIEW_V2_STREAM_TEXT=1`, emitted text is passed through the same redaction layer used for session artifacts before it is persisted to `events.ndjson`. Even then, streaming text should be treated as diagnostic data, because providers can split sensitive strings across chunks. The default count-only mode avoids that class of leakage.

`server_info` exposes the effective streaming configuration, and `runtime_capabilities.token_streaming` reflects the active `CROSS_REVIEW_V2_STREAM_TOKENS` setting. Streaming does not change the unanimity gate and does not persist raw chain-of-thought.

## Install

```powershell
npm install
npm run build
```

## Run MCP Server

```powershell
npm run build
node dist/src/mcp/server.js
```

Real peer calls can take longer than a generic MCP client's default 60-second request timeout. Hosts and test clients should use at least 300s for MCP tool calls:

```toml
[mcp_servers.cross-review-v2]
tool_timeout_sec = 300
command = "node"
args = ["C:/Users/leona/lcv-workspace/cross-review-v2/dist/src/mcp/server.js"]
env_vars = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]
env = { CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS = "20000" }
```

Provider HTTP calls use `CROSS_REVIEW_V2_TIMEOUT_MS`, which defaults to 30 minutes. The 300s setting above is for the MCP client-to-server request.

For local no-cost smoke tests only:

```powershell
$env:CROSS_REVIEW_V2_STUB="1"
npm test
```

For a real provider streaming check with the four API keys, run:

```powershell
npm run api-streaming-smoke
```

The real smoke prints model names, status, usage and token-event counts only. It does not print prompts, provider text or API keys.

## Dashboard

```powershell
npm run dashboard
```

Then open `http://127.0.0.1:4588`.

## MCP Tools

- `server_info`
- `runtime_capabilities`
- `probe_peers`
- `session_init`
- `session_list`
- `session_read`
- `ask_peers`
- `session_start_round`
- `run_until_unanimous`
- `session_start_unanimous`
- `session_cancel_job`
- `session_recover_interrupted`
- `session_poll`
- `session_events`
- `session_metrics`
- `session_report`
- `session_check_convergence`
- `session_attach_evidence`
- `escalate_to_operator`
- `session_sweep`
- `session_finalize`

## Review Focus

Use optional `review_focus` when a broad review needs a stable scope anchor, for example `services/billing`, `src/core/session-store.ts`, or `release automation`.

The field is available on `session_init`, `ask_peers`, `session_start_round`, `run_until_unanimous` and `session_start_unanimous`. Session-level focus is saved as `meta.review_focus`; per-call focus overrides it for that round or unanimous run. The runtime injects the value as a bounded/redacted Markdown `Review Focus` block at the start of generation, review, revision and retry prompts. If an operator accidentally pastes a leading `/focus`, the prefix is stripped during normalization and only the plain scope text is forwarded.

The injected block also tells reviewers to label possible findings outside that focus as `OUT OF SCOPE` instead of counting them as blocking issues, unless the issue is a critical cross-cutting blocker that invalidates the result. This keeps broad reviews anchored without hiding genuinely fatal problems.

This is intentionally not Claude Code's `/focus` slash command. Official Claude Code docs describe `/focus` as a focus-mode UI toggle; Cross Review uses `review_focus` so the same instruction works for OpenAI/Codex, Anthropic/Claude, Gemini and DeepSeek.

## Observe the Session

Session metadata records in-flight rounds, convergence scope, convergence health, failed attempts, operator escalations, fallback events and attached evidence files. Each session can also produce `events.ndjson`, aggregate metrics and `session-report.md`, so long-running runs can be followed without waiting for a synchronous MCP call to return.

`session_start_round` and `session_start_unanimous` return immediately with a `job_id` and `session_id`. Use `session_poll` for state, `session_events` for incremental events, `session_metrics` for cost/latency/failure summaries, `session_cancel_job` for cooperative cancellation and `session_report` for the current Markdown report.

Provider responses that report a different model from the model requested are recorded as `silent_model_downgrade` failures and block convergence. Responses that cannot be parsed after one automatic format-recovery retry are recorded as `unparseable_after_recovery` failures.

When a provider rejects a prompt through moderation or safety filtering, the orchestrator records `prompt_flagged_by_moderation`, retries once with a compact sanitized review prompt, and marks successful retries with `decision_quality: recovered`. This is designed for verbose peer discussions that should be summarized, not replayed verbatim, in later prompts.

Secret redaction is applied when prompts, responses, evidence and JSON metadata are written. The redactor covers known API-key and token formats; new credential formats should be added before public test fixtures are promoted.

## Security

- Public-repo ready `.gitignore`.
- No secrets in committed files.
- GitHub Pages via Actions artifact deployment.
- Dependabot configured.
- Dependabot automerge workflow prepared.
- Pushes to `main` auto-create an organization-standard display tag such as `v02.01.00` from `package.json`; the tag then creates a normal GitHub Release and publishes `@lcv-ideas-software/cross-review-v2` to npmjs.com and GitHub Packages.
- CodeQL must be enabled through GitHub Default Setup after repository creation. Advanced Setup requires prior authorization.

## Status

Current version: `v02.03.01` (npm package `2.3.1`).

Version `v02.01.00` (npm package `2.1.0`) is the first stable release of `cross-review-v2`.

## License

**Apache License 2.0** — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright 2026 Leonardo Cardozo Vargas.

## Links

- Release history: [`CHANGELOG.md`](./CHANGELOG.md)
- Security: [`SECURITY.md`](./SECURITY.md)
- License: [`LICENSE`](./LICENSE)
