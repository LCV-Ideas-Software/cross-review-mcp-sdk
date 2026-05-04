<p align="center">
  <img src=".github/assets/lcv-ideas-software-logo.svg" alt="LCV Ideas & Software" width="520" />
</p>

# cross-review-v2

> MCP server orchestrating API-first cross-review between Claude, ChatGPT Codex,
> Gemini, and DeepSeek with unanimous convergence gates.

[![status: stable](https://img.shields.io/badge/status-stable-brightgreen.svg)](#status)
[![npm](https://img.shields.io/npm/v/@lcv-ideas-software/cross-review-v2.svg)](https://www.npmjs.com/package/@lcv-ideas-software/cross-review-v2)
[![runtime: API-only](https://img.shields.io/badge/runtime-API--only-blue.svg)](#what-it-does)
[![security: CodeQL Default Setup](https://img.shields.io/badge/security-CodeQL%20Default%20Setup-informational.svg)](#security)
[![license: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green.svg)](./LICENSE)

**Install.**

```bash
npm install -g @lcv-ideas-software/cross-review-v2
# or using the GitHub Packages mirror:
npm install -g @lcv-ideas-software/cross-review-v2 --registry=https://npm.pkg.github.com
```

**Status.** Stable. Current release: **v02.15.00** (npm package `2.15.0`). See
[CHANGELOG.md](./CHANGELOG.md) for the release history.

## What It Does

`cross-review-v2` is the stable API-first implementation of the cross-review
pattern. It orchestrates provider API clients (OpenAI/Codex, Anthropic/Claude,
Google Gemini, and DeepSeek) and provides an MCP-compatible server surface.

Runtime calls are real provider calls by default. Stubs exist only for smoke
tests and CI when `CROSS_REVIEW_V2_STUB=1`.

- OpenAI client library for the Codex/OpenAI peer.
- Anthropic TypeScript client library for Claude.
- Google Gen AI client library for Gemini.
- OpenAI-compatible DeepSeek API through the OpenAI client library.

## Quick Start

```powershell
# Set API keys (PowerShell example)
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<OPENAI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<ANTHROPIC_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "<GEMINI_API_KEY>", "User")
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "<DEEPSEEK_API_KEY>", "User")
```

Restart your terminal after changing environment variables.

Build and run locally:

```bash
npm install
npm run build
node dist/src/mcp/server.js
```

For local smoke tests (no-cost):

```powershell
$env:CROSS_REVIEW_V2_STUB = "1"
npm test
```

## Configuration

Model selection and runtime behaviour can be controlled with environment
variables. Example overrides (PowerShell):

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh", "User")
```

Financial and budget controls are required for paid provider calls. Configure
these environment variables before running real sessions (example):

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_MAX_SESSION_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_PREFLIGHT_MAX_ROUND_COST_USD", "20", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_V2_UNTIL_STOPPED_MAX_COST_USD", "20", "User")
```

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

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright 2026 Leonardo Cardozo Vargas.
