# Architecture

This API-only `cross-review-mcp-sdk` implementation is intentionally independent from the current CLI-based `cross-review-mcp` project.

## Runtime Layers

1. MCP server: exposes workflow tools over stdio.
2. Orchestrator: creates sessions, runs reviews, checks unanimity and asks the lead peer to revise.
3. Peer adapters: call official provider SDKs/APIs.
4. Model selection: queries model APIs and chooses the highest-capability documented model available to the key.
5. Session store: writes durable JSON and Markdown artifacts under `data/sessions`.
6. Observability: writes one NDJSON log per process under `data/logs`.
7. Dashboard: local read-only HTTP UI for sessions and probes.

## Real Execution Rule

Runtime default is real API execution. Stubs are disabled unless `CROSS_REVIEW_SDK_STUB=1`.

## Timeout Model

Real API review rounds are intentionally long-running. The provider-side HTTP
timeout is controlled by `CROSS_REVIEW_SDK_TIMEOUT_MS` and defaults to 30
minutes.

MCP hosts also have their own client-to-server request timeout. For real peer
calls, configure the host timeout to at least 300 seconds. A lower generic
default, such as 60 seconds, can close the MCP request while the provider calls
are still legitimately processing.

## Unanimity Rule

A session converges only when the caller status is `READY`, every selected peer returns `READY`, and no peer failed or omitted a machine-readable status.

## Model Discovery

Provider model APIs are queried at probe/session initialization:

- OpenAI: Models API.
- Anthropic: Models API.
- Gemini: `models.list`.
- DeepSeek: OpenAI-compatible `/models`.

The selected model and selection evidence are persisted in the session capability snapshot.
