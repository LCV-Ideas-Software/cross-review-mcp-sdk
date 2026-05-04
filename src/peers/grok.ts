// v2.14.0 (item 5, operator directive 2026-05-04): Grok adapter.
//
// xAI's Grok exposes the OpenAI Responses API surface at base URL
// `https://api.x.ai/v1`, so this adapter is structurally near-identical
// to `peers/openai.ts` — same `client.responses.create()` invocation
// shape, same streaming event protocol, same JSON schema text-format
// gate. Only deltas:
//   - `id = "grok"` (5th peer in PEERS as of v2.14.0)
//   - `provider = "xai"`
//   - default model `grok-4-latest` (operator-corrected; NOT grok-4.3)
//   - auth via `XAI_API_KEY` (canonical) with `GROK_API_KEY` fallback
//   - OpenAI client constructed with `baseURL: "https://api.x.ai/v1"`
//
// Copied from openai.ts rather than refactored into a shared base
// because the OpenAI adapter has provider-specific quirks (stream event
// shapes, error classification heuristics) that are easier to maintain
// per-adapter than to abstract; same precedent the codebase already
// follows with deepseek (which also uses an OpenAI-compatible surface).
import OpenAI from "openai";
import type {
  AppConfig,
  GenerationResult,
  PeerAdapter,
  PeerCallContext,
  PeerId,
  PeerProbeResult,
  PeerResult,
  TokenUsage,
} from "../core/types.js";
import { statusInstruction, statusJsonSchema } from "../core/status.js";
import { BasePeerAdapter, StreamBuffer } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { withRetry } from "./retry.js";
import { textFromOpenAIResponse, userPrompt } from "./text.js";

type GrokReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type GrokUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
};

type GrokStreamEvent = {
  type: string;
  delta?: unknown;
  response?: {
    usage?: GrokUsage | null;
    model?: string;
    error?: { message?: string };
  };
  error?: { message?: string };
};

const GROK_BASE_URL = "https://api.x.ai/v1";

function usageFromGrok(usage: GrokUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
  };
}

function grokEffort(value: AppConfig["reasoning_effort"][PeerId]): GrokReasoningEffort {
  return value === "max" ? "xhigh" : (value ?? "xhigh");
}

export class GrokAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "grok";
  provider = "xai";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.grok;
  }

  private client(): OpenAI {
    const apiKey = this.config.api_keys.grok;
    if (!apiKey) {
      throw new Error("GROK_API_KEY was not found in environment variables.");
    }
    return new OpenAI({ apiKey, baseURL: GROK_BASE_URL });
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.grok);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.grok,
        message: "GROK_API_KEY is missing.",
      };
    }
    try {
      await this.client().models.list();
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.grok,
      };
    } catch (error) {
      const failure = classifyProviderError(this.id, this.provider, this.model, error, 1, started);
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.grok,
        message: failure.message,
      };
    }
  }

  async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
    const started = Date.now();
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.call.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `Grok review attempt ${attempt}`,
        });
        const body = {
          model: this.model,
          input: [
            { role: "system" as const, content: this.systemPrompt(context) },
            {
              role: "user" as const,
              content: `${userPrompt(prompt)}\n\n${statusInstruction()}`,
            },
          ],
          text: {
            format: {
              type: "json_schema" as const,
              name: "cross_review_status",
              strict: true,
              schema: statusJsonSchema,
            },
            verbosity: "low" as const,
          },
          reasoning: { effort: grokEffort(this.config.reasoning_effort.grok) },
          store: false,
          max_output_tokens: this.config.max_output_tokens,
        };
        if (this.shouldStreamTokens(context)) {
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "response.output_text.delta",
          );
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          const stream = await this.client().responses.create(
            { ...body, stream: true },
            { signal: context.signal, timeout: this.config.retry.timeout_ms },
          );
          for await (const event of stream as AsyncIterable<GrokStreamEvent>) {
            if (event.type === "response.output_text.delta") {
              const delta = typeof event.delta === "string" ? event.delta : "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            } else if (event.type === "response.completed") {
              usage = usageFromGrok(event.response?.usage);
              modelReported = event.response?.model;
            } else if (event.type === "response.failed" || event.type === "response.error") {
              const message =
                event.type === "response.failed"
                  ? event.response?.error?.message
                  : event.error?.message;
              throw new Error(message ?? "Grok streaming response failed.");
            }
          }
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          return this.resultFromText({
            text,
            raw: { streamed: true, provider: this.provider, model: modelReported ?? this.model },
            usage,
            started,
            attempts: attempt,
            modelReported,
          });
        }
        const response = await this.client().responses.create(body, {
          signal: context.signal,
          timeout: this.config.retry.timeout_ms,
        });
        return this.resultFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: usageFromGrok(response.usage),
          started,
          attempts: attempt,
          modelReported: response.model,
        });
      },
      (error, attempt) =>
        classifyProviderError(this.id, this.provider, this.model, error, attempt, started),
    );
  }

  async generate(prompt: string, context: PeerCallContext): Promise<GenerationResult> {
    const started = Date.now();
    return withRetry(
      this.config,
      async (attempt) => {
        context.emit({
          type: "peer.generate.started",
          session_id: context.session_id,
          round: context.round,
          peer: this.id,
          message: `Grok generation attempt ${attempt}`,
        });
        const body = {
          model: this.model,
          input: [
            { role: "system" as const, content: this.systemPrompt(context) },
            { role: "user" as const, content: userPrompt(prompt) },
          ],
          reasoning: { effort: grokEffort(this.config.reasoning_effort.grok) },
          store: false,
          max_output_tokens: this.config.max_output_tokens,
        };
        if (this.shouldStreamTokens(context)) {
          const stream_buffer = new StreamBuffer(this.id);
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "response.output_text.delta",
          );
          let usage: TokenUsage | undefined;
          let modelReported: string | undefined;
          const stream = await this.client().responses.create(
            { ...body, stream: true },
            { signal: context.signal, timeout: this.config.retry.timeout_ms },
          );
          for await (const event of stream as AsyncIterable<GrokStreamEvent>) {
            if (event.type === "response.output_text.delta") {
              const delta = typeof event.delta === "string" ? event.delta : "";
              stream_buffer.append(delta);
              tokenStream.append(delta);
            } else if (event.type === "response.completed") {
              usage = usageFromGrok(event.response?.usage);
              modelReported = event.response?.model;
            } else if (event.type === "response.failed" || event.type === "response.error") {
              const message =
                event.type === "response.failed"
                  ? event.response?.error?.message
                  : event.error?.message;
              throw new Error(message ?? "Grok streaming response failed.");
            }
          }
          const text = stream_buffer.text();
          tokenStream.complete(text.length);
          return this.generationFromText({
            text,
            raw: { streamed: true, provider: this.provider, model: modelReported ?? this.model },
            usage,
            started,
            attempts: attempt,
            modelReported,
          });
        }
        const response = await this.client().responses.create(body, {
          signal: context.signal,
          timeout: this.config.retry.timeout_ms,
        });
        return this.generationFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: usageFromGrok(response.usage),
          started,
          attempts: attempt,
          modelReported: response.model,
        });
      },
      (error, attempt) =>
        classifyProviderError(this.id, this.provider, this.model, error, attempt, started),
    );
  }
}
