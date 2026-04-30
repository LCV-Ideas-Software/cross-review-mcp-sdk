# Costs

Runtime calls are real provider API calls by default.

## Smoke Tests

`npm test` uses `CROSS_REVIEW_V2_STUB=1` and does not call provider APIs.

## Real Runs

`probe_peers`, `session_init`, `ask_peers` and `run_until_unanimous` may call provider APIs when keys are present.

The server records token usage returned by providers. Cost estimates are marked `unknown-rate` unless rates are configured in code or future runtime configuration. This avoids stale hard-coded prices because provider pricing changes frequently.

## Optional Rate Configuration

Set rates through Windows environment variables when you want session reports to
estimate costs. Values are USD per million tokens.

```powershell
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_INPUT_USD_PER_MILLION", "0", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_OPENAI_OUTPUT_USD_PER_MILLION", "0", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_INPUT_USD_PER_MILLION", "0", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_ANTHROPIC_OUTPUT_USD_PER_MILLION", "0", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_INPUT_USD_PER_MILLION", "0", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_GEMINI_OUTPUT_USD_PER_MILLION", "0", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_INPUT_USD_PER_MILLION", "0", "User")
[Environment]::SetEnvironmentVariable("CROSS_REVIEW_DEEPSEEK_OUTPUT_USD_PER_MILLION", "0", "User")
```

Use current provider pricing when setting these values. The project does not
hard-code provider prices because they can change without a code release.

## Optional Budget Guard

`CROSS_REVIEW_V2_MAX_SESSION_COST_USD` sets a default per-session budget guard.
`CROSS_REVIEW_V2_PREFLIGHT_MAX_ROUND_COST_USD` can block a round before calls
begin when the estimated cost exceeds the configured value.
The `run_until_unanimous` and `session_start_unanimous` tools also accept
`max_cost_usd` for a single run.

When the estimated session cost exceeds the configured limit, the run is
finalized as `max-rounds` with reason `budget_exceeded`. Unknown-rate sessions
cannot enforce cost budgets until rates are configured.
