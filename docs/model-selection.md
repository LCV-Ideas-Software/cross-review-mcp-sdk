# Model Selection

The server uses automatic model selection unless an explicit environment override is present.

## Rules

1. Query the provider's official model API using the current API key.
2. Keep only models that can perform text generation for the peer role.
3. Compare returned model IDs against the documented priority list.
4. Select the first available model in that priority list.
5. Persist the selected model, candidate list, source URL, confidence and reason in the session snapshot.

## Current Priority Lists

OpenAI/Codex:

```text
gpt-5.5 > gpt-5.4 > gpt-5.2 > gpt-5.1-codex-max > gpt-5.1-codex > gpt-5.1 > gpt-5-pro > gpt-5
```

Anthropic/Claude:

```text
claude-opus-4-7 > claude-opus-4-6 > claude-sonnet-4-6 > claude-haiku-4-5
```

Google/Gemini:

```text
gemini-3.1-pro-preview > gemini-3-pro-preview > gemini-2.5-pro
```

DeepSeek:

```text
deepseek-v4-pro > deepseek-v4-flash > deepseek-reasoner > deepseek-chat
```

## Important

The priority list is intentionally code-level configuration, not hidden behavior. Provider model catalogs change often, so this file and `src/peers/model-selection.ts` must be reviewed whenever provider docs change.
