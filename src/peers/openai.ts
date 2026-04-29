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
import { BasePeerAdapter } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { withRetry } from "./retry.js";
import { textFromOpenAIResponse, userPrompt } from "./text.js";

type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type OpenAIUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
};

function usageFromOpenAI(usage: OpenAIUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.output_tokens_details?.reasoning_tokens,
  };
}

function openAIEffort(value: AppConfig["reasoning_effort"][PeerId]): OpenAIReasoningEffort {
  return value === "max" ? "xhigh" : (value ?? "xhigh");
}

export class OpenAIAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "codex";
  provider = "openai";
  model: string;

  constructor(config: AppConfig) {
    super(config);
    this.model = config.models.codex;
  }

  private client(): OpenAI {
    const apiKey = this.config.api_keys.codex;
    if (!apiKey) throw new Error("OPENAI_API_KEY was not found in environment variables.");
    return new OpenAI({ apiKey });
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.codex);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.codex,
        message: "OPENAI_API_KEY is missing.",
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
        model_selection: this.config.model_selection.codex,
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
        model_selection: this.config.model_selection.codex,
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
          message: `OpenAI review attempt ${attempt}`,
        });
        const response = await this.client().responses.create(
          {
            model: this.model,
            input: [
              { role: "system", content: this.systemPrompt(context) },
              { role: "user", content: `${userPrompt(prompt)}\n\n${statusInstruction()}` },
            ],
            text: {
              format: {
                type: "json_schema",
                name: "cross_review_status",
                strict: true,
                schema: statusJsonSchema,
              },
              verbosity: "low",
            },
            reasoning: { effort: openAIEffort(this.config.reasoning_effort.codex) },
            store: false,
            max_output_tokens: 4096,
          },
          { signal: context.signal, timeout: this.config.retry.timeout_ms },
        );
        return this.resultFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: usageFromOpenAI(response.usage),
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
          message: `OpenAI generation attempt ${attempt}`,
        });
        const response = await this.client().responses.create(
          {
            model: this.model,
            input: [
              { role: "system", content: this.systemPrompt(context) },
              { role: "user", content: userPrompt(prompt) },
            ],
            reasoning: { effort: openAIEffort(this.config.reasoning_effort.codex) },
            store: false,
            max_output_tokens: 20000,
          },
          { signal: context.signal, timeout: this.config.retry.timeout_ms },
        );
        return this.generationFromText({
          text: textFromOpenAIResponse(response),
          raw: response,
          usage: usageFromOpenAI(response.usage),
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
