# Costs

Runtime calls are real provider API calls by default.

## Smoke Tests

`npm test` uses `CROSS_REVIEW_SDK_STUB=1` and does not call provider APIs.

## Real Runs

`probe_peers`, `session_init`, `ask_peers` and `run_until_unanimous` may call provider APIs when keys are present.

The server records token usage returned by providers. Cost estimates are marked `unknown-rate` unless rates are configured in code or future runtime configuration. This avoids stale hard-coded prices because provider pricing changes frequently.
