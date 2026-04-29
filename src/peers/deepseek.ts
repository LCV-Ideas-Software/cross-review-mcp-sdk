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
import { statusInstruction } from "../core/status.js";
import { BasePeerAdapter } from "./base.js";
import { classifyProviderError } from "./errors.js";
import { withRetry } from "./retry.js";
import { userPrompt } from "./text.js";

type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};

function usageFromChat(usage: ChatUsage | null | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

function chatText(response: {
  choices?: Array<{ message?: { content?: string | null } }>;
}): string {
  return response.choices?.[0]?.message?.content?.trim() || JSON.stringify(response);
}

export class DeepSeekAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "deepseek";
  provider = "deepseek";
  model: string;

  constructor(config: AppConfig) {
    super(config);
    this.model = config.models.deepseek;
  }

  private client(): OpenAI {
    const apiKey = this.config.api_keys.deepseek;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY was not found in environment variables.");
    return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.deepseek);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.deepseek,
        message: "DEEPSEEK_API_KEY is missing.",
      };
    }
    try {
      await this.client().models.list({ timeout: this.config.retry.timeout_ms });
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.deepseek,
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
        model_selection: this.config.model_selection.deepseek,
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
          message: `DeepSeek review attempt ${attempt}`,
        });
        const response = await this.client().chat.completions.create(
          {
            model: this.model,
            messages: [
              { role: "system", content: this.systemPrompt(context) },
              { role: "user", content: `${userPrompt(prompt)}\n\n${statusInstruction()}` },
            ],
            response_format: { type: "json_object" },
            max_tokens: 4096,
          },
          { signal: context.signal, timeout: this.config.retry.timeout_ms },
        );
        return this.resultFromText({
          text: chatText(response),
          raw: response,
          usage: usageFromChat(response.usage),
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
          message: `DeepSeek generation attempt ${attempt}`,
        });
        const response = await this.client().chat.completions.create(
          {
            model: this.model,
            messages: [
              { role: "system", content: this.systemPrompt(context) },
              { role: "user", content: userPrompt(prompt) },
            ],
            max_tokens: 20000,
          },
          { signal: context.signal, timeout: this.config.retry.timeout_ms },
        );
        return this.generationFromText({
          text: chatText(response),
          raw: response,
          usage: usageFromChat(response.usage),
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
