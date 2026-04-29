<p align="center">
  <img src=".github/assets/lcv-ideas-software-logo.svg" alt="LCV Ideas & Software" width="520" />
</p>

# cross-review-mcp-sdk

API/SDK-first MCP server for multi-model cross-review with unanimous convergence gates.

![status](https://img.shields.io/badge/status-alpha-orange)
![sdk](https://img.shields.io/badge/runtime-SDK--only-blue)
![license](https://img.shields.io/badge/license-Apache--2.0-green)
![security](https://img.shields.io/badge/CodeQL-Default%20Setup-blue)

## What This Is

`cross-review-mcp-sdk` is a new API-only implementation of the cross-review pattern. It does not execute Claude CLI, Codex CLI, Gemini CLI, DeepSeek CLI, PowerShell shells, or terminal sessions. The peers are called through official APIs and SDKs:

- OpenAI SDK for the Codex/OpenAI peer.
- Anthropic TypeScript SDK for Claude.
- Google Gen AI SDK for Gemini.
- OpenAI-compatible DeepSeek API via the official OpenAI SDK.

By default, runtime calls are real provider calls. Stubs exist only for smoke tests and CI when `CROSS_REVIEW_SDK_STUB=1`.

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
- Anthropic/Claude: `claude-opus-4-7`.
- Google/Gemini: `gemini-3.1-pro-preview`.
- DeepSeek: `deepseek-v4-pro`.

Explicit env var overrides always win:

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_MODEL", "claude-opus-4-7", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_MODEL", "gemini-3.1-pro-preview", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_MODEL", "deepseek-v4-pro", "User")
```

Each probe records the selected model, candidates returned by the API, source URL, confidence and selection reason.

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

Real peer calls can easily take longer than a generic MCP client's default
60-second request timeout. Hosts and test clients should use at least 300s for
MCP tool calls:

```toml
[mcp_servers.cross-review-mcp-sdk]
tool_timeout_sec = 300
command = "node"
args = ["C:/Users/leona/lcv-workspace/cross-review-mcp-sdk/dist/src/mcp/server.js"]
env_vars = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]
```

Provider HTTP calls use `CROSS_REVIEW_SDK_TIMEOUT_MS`, which defaults to 30
minutes. The 300s setting above is for the MCP client-to-server request.

For local no-cost smoke tests only:

```powershell
$env:CROSS_REVIEW_SDK_STUB="1"
npm test
```

## Dashboard

```powershell
npm run dashboard
```

Then open `http://127.0.0.1:4588`.

## MCP Tools

- `server_info`
- `probe_peers`
- `session_init`
- `session_list`
- `session_read`
- `ask_peers`
- `session_start_round`
- `run_until_unanimous`
- `session_start_unanimous`
- `session_poll`
- `session_events`
- `session_report`
- `session_check_convergence`
- `session_attach_evidence`
- `escalate_to_operator`
- `session_sweep`
- `session_finalize`

## Session Observability

Session metadata records in-flight rounds, convergence scope, convergence health, failed attempts, operator escalations and attached evidence files. Each session can also produce `events.ndjson` and `session-report.md`, so long-running runs can be followed without waiting for a synchronous MCP call to return.

`session_start_round` and `session_start_unanimous` return immediately with a `job_id` and `session_id`. Use `session_poll` for state, `session_events` for incremental events and `session_report` for the current Markdown report.

Provider responses that report a different model from the model requested are recorded as `silent_model_downgrade` failures and block convergence. Responses that cannot be parsed after one automatic format-recovery retry are recorded as `unparseable_after_recovery` failures.

When a provider rejects a prompt through moderation or safety filtering, the orchestrator records `prompt_flagged_by_moderation`, retries once with a compact sanitized review prompt, and marks successful retries with `decision_quality: recovered`. This is designed for verbose peer discussions that should be summarized, not replayed verbatim, in later prompts.

Secret redaction is applied when prompts, responses, evidence and JSON metadata are written. The redactor covers known API-key and token formats; new credential formats should be added before public test fixtures are promoted.

## Security Baseline

- Public-repo ready `.gitignore`.
- No secrets in committed files.
- GitHub Pages via Actions artifact deployment.
- Dependabot configured.
- Dependabot automerge workflow prepared.
- Pushes to `main` auto-create an organization-standard display tag such as `v02.00.04` from `package.json`; the tag then creates a normal GitHub Release and publishes `@lcv-ideas-software/cross-review-mcp-sdk` to npmjs.com and GitHub Packages. Prerelease package versions keep their prerelease label as an npm alias such as `alpha`; `latest` follows the newest published package version.
- CodeQL must be enabled through GitHub Default Setup after repository creation. Advanced Setup requires prior authorization.

## Status

Version `v02.00.04` (npm package `2.0.4-alpha.0`) is an SDK-only alpha implementation. It is intentionally separate from the existing CLI-based `cross-review-mcp` and does not modify that repository.
