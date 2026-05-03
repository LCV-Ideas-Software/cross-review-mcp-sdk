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
import { BasePeerAdapter, STREAM_TEXT_MAX_BYTES, StreamBufferOverflowError } from "./base.js";
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

function anthropicThinking(): { type: "adaptive"; display: "omitted" } {
  return { type: "adaptive", display: "omitted" };
}

export class AnthropicAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "claude";
  provider = "anthropic";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.claude;
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
        const body = {
          model: this.model,
          max_tokens: this.config.max_output_tokens,
          system: this.systemPrompt(context),
          messages: [
            {
              role: "user" as const,
              content: `${userPrompt(prompt)}\n\n${statusInstruction()}`,
            },
          ],
          thinking: anthropicThinking(),
          output_config: {
            effort: anthropicEffort(this.config.reasoning_effort.claude),
            format: {
              type: "json_schema" as const,
              schema: statusJsonSchema,
            },
          },
        };
        if (this.shouldStreamTokens(context)) {
          // v2.4.0 / audit closure (P2.9): track streamed-text bytes
          // incrementally so a hostile or buggy peer cannot silently
          // accumulate gigabytes inside the SDK before finalMessage()
          // resolves. We cannot interrupt the SDK's internal buffer
          // directly, but throwing on overflow propagates through the
          // promise chain and the retry layer classifies the failure.
          const stream = this.client().messages.stream(body, { signal: context.signal });
          const tokenStream = this.createTokenEventBuffer(
            context,
            "review",
            "content_block_delta.text_delta",
          );
          let streamedBytes = 0;
          stream.on("text", (delta) => {
            streamedBytes += Buffer.byteLength(delta, "utf8");
            if (streamedBytes > STREAM_TEXT_MAX_BYTES) {
              stream.controller.abort();
              throw new StreamBufferOverflowError(this.id, streamedBytes);
            }
            tokenStream.append(delta);
          });
          const message = await stream.finalMessage();
          const text = textFromAnthropicContent(message.content);
          tokenStream.complete(text.length);
          return this.resultFromText({
            text,
            raw: { streamed: true, provider: this.provider, model: message.model },
            usage: usageFromAnthropic(message.usage),
            started,
            attempts: attempt,
            modelReported: message.model,
          });
        }
        const message = await this.client().messages.create(body, { signal: context.signal });
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
        const body = {
          model: this.model,
          max_tokens: this.config.max_output_tokens,
          system: this.systemPrompt(context),
          messages: [{ role: "user" as const, content: userPrompt(prompt) }],
          thinking: anthropicThinking(),
          output_config: {
            effort: anthropicEffort(this.config.reasoning_effort.claude),
          },
        };
        if (this.shouldStreamTokens(context)) {
          const stream = this.client().messages.stream(body, { signal: context.signal });
          const tokenStream = this.createTokenEventBuffer(
            context,
            "generation",
            "content_block_delta.text_delta",
          );
          let streamedBytes = 0;
          stream.on("text", (delta) => {
            streamedBytes += Buffer.byteLength(delta, "utf8");
            if (streamedBytes > STREAM_TEXT_MAX_BYTES) {
              stream.controller.abort();
              throw new StreamBufferOverflowError(this.id, streamedBytes);
            }
            tokenStream.append(delta);
          });
          const message = await stream.finalMessage();
          const text = textFromAnthropicContent(message.content);
          tokenStream.complete(text.length);
          return this.generationFromText({
            text,
            raw: { streamed: true, provider: this.provider, model: message.model },
            usage: usageFromAnthropic(message.usage),
            started,
            attempts: attempt,
            modelReported: message.model,
          });
        }
        const message = await this.client().messages.create(body, { signal: context.signal });
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
