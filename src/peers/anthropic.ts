import Anthropic from "@anthropic-ai/sdk";
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
import { textFromAnthropicContent, userPrompt } from "./text.js";

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

type AnthropicUsage = {
  input_tokens?: number | null;
  output_tokens?: number;
};

function usageFromAnthropic(usage: AnthropicUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.input_tokens ?? undefined;
  const output = usage.output_tokens;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: (input ?? 0) + (output ?? 0),
  };
}

function anthropicEffort(value: AppConfig["reasoning_effort"][PeerId]): AnthropicEffort {
  if (value === "none" || value === "minimal") return "low";
  return value ?? "max";
}

export class AnthropicAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "claude";
  provider = "anthropic";
  model: string;

  constructor(config: AppConfig) {
    super(config);
    this.model = config.models.claude;
  }

  private client(): Anthropic {
    const apiKey = this.config.api_keys.claude;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY was not found in environment variables.");
    return new Anthropic({ apiKey, timeout: this.config.retry.timeout_ms });
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.claude);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.claude,
        message: "ANTHROPIC_API_KEY is missing.",
      };
    }
    try {
      await this.client().messages.countTokens({
        model: this.model,
        messages: [{ role: "user", content: "probe" }],
      });
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.claude,
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
        model_selection: this.config.model_selection.claude,
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
          message: `Anthropic review attempt ${attempt}`,
        });
        const message = await this.client().messages.create(
          {
            model: this.model,
            max_tokens: 4096,
            system: this.systemPrompt(context),
            messages: [
              { role: "user", content: `${userPrompt(prompt)}\n\n${statusInstruction()}` },
            ],
            output_config: {
              effort: anthropicEffort(this.config.reasoning_effort.claude),
              format: {
                type: "json_schema",
                schema: statusJsonSchema,
              },
            },
          },
          { signal: context.signal },
        );
        return this.resultFromText({
          text: textFromAnthropicContent(message.content),
          raw: message,
          usage: usageFromAnthropic(message.usage),
          started,
          attempts: attempt,
          modelReported: message.model,
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
          message: `Anthropic generation attempt ${attempt}`,
        });
        const message = await this.client().messages.create(
          {
            model: this.model,
            max_tokens: 20000,
            system: this.systemPrompt(context),
            messages: [{ role: "user", content: userPrompt(prompt) }],
            output_config: {
              effort: anthropicEffort(this.config.reasoning_effort.claude),
            },
          },
          { signal: context.signal },
        );
        return this.generationFromText({
          text: textFromAnthropicContent(message.content),
          raw: message,
          usage: usageFromAnthropic(message.usage),
          started,
          attempts: attempt,
          modelReported: message.model,
        });
      },
      (error, attempt) =>
        classifyProviderError(this.id, this.provider, this.model, error, attempt, started),
    );
  }
}
