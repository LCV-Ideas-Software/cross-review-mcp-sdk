import type { PeerFailure, PeerId } from "../core/types.js";
import { safeErrorMessage } from "../security/redact.js";

export function classifyProviderError(
  peer: PeerId,
  provider: string,
  model: string,
  error: unknown,
  attempts: number,
  started: number,
): PeerFailure {
  const message = safeErrorMessage(error);
  const contextual429 =
    /\b(?:http|status|statuscode|code|error)\s*[:=]?\s*["'(]?\s*429\b/i.test(message) ||
    /\b429\s+(?:too many requests|rate[-_\s]?limit|quota|retry-after)\b/i.test(message);
  const rateLimited =
    contextual429 ||
    /\b(?:too many requests|rate[-_\s]?limit(?:ed|ing)?|quota exceeded|resource_exhausted|retry-after)\b/i.test(
      message,
    );
  const auth =
    /\b(?:401|403|unauthorized|forbidden|invalid api key|missing api key|expired api key|authentication failed|authentication required)\b/i.test(
      message,
    );
  const moderation =
    /\b(?:invalid_prompt|prompt[_\s-]?flagged|moderation|moderated|safety policy|safety system|usage policy|responsibleaipolicyviolation|content[_\s-]?filter|blocked by policy|policy violation|could not be processed|input was rejected)\b/i.test(
      message,
    );
  const timeout = /\b(?:timeout|aborted|aborterror)\b/i.test(message);
  const network = /\b(?:econnreset|enotfound|etimedout|network|fetch failed)\b/i.test(message);

  const failureClass = auth
    ? "auth"
    : moderation
      ? "prompt_flagged_by_moderation"
      : rateLimited
        ? "rate_limit"
        : timeout
          ? "timeout"
          : network
            ? "network"
            : "provider_error";

  return {
    peer,
    provider,
    model,
    failure_class: failureClass,
    message,
    retryable: rateLimited || timeout || network,
    recovery_hint: rateLimited
      ? "wait_and_retry"
      : moderation
        ? "reformulate_and_retry"
        : undefined,
    reformulation_advice: moderation
      ? "Rephrase the request in neutral technical language, compact prior peer discussion, avoid quoting flagged text, and keep the same engineering intent."
      : undefined,
    attempts,
    latency_ms: Date.now() - started,
  };
}
