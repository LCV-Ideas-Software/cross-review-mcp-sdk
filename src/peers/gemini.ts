import { GoogleGenAI } from "@google/genai";
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
import { userPrompt } from "./text.js";

type GeminiUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
};

type GeminiResponse = {
  text?: string;
  modelVersion?: string;
  usageMetadata?: GeminiUsage;
};

function usageFromGemini(usage: GeminiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.promptTokenCount,
    output_tokens: usage.candidatesTokenCount,
    total_tokens: usage.totalTokenCount,
    reasoning_tokens: usage.thoughtsTokenCount,
  };
}

export class GeminiAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "gemini";
  provider = "google";
  model: string;

  constructor(config: AppConfig) {
    super(config);
    this.model = config.models.gemini;
  }

  private client(): GoogleGenAI {
    const apiKey = this.config.api_keys.gemini;
    if (!apiKey) throw new Error("GEMINI_API_KEY was not found in environment variables.");
    return new GoogleGenAI({ apiKey });
  }

  async probe(): Promise<PeerProbeResult> {
    const started = Date.now();
    const authPresent = Boolean(this.config.api_keys.gemini);
    if (!authPresent) {
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: false,
        auth_present: false,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.gemini,
        message: "GEMINI_API_KEY is missing.",
      };
    }
    try {
      const pager = await this.client().models.list({ config: { pageSize: 1 } });
      for await (const model of pager) {
        void model;
        break;
      }
      return {
        peer: this.id,
        provider: this.provider,
        model: this.model,
        available: true,
        auth_present: true,
        latency_ms: Date.now() - started,
        model_selection: this.config.model_selection.gemini,
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
        model_selection: this.config.model_selection.gemini,
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
          message: `Gemini review attempt ${attempt}`,
        });
        const response = (await this.client().models.generateContent({
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}\n\n${statusInstruction()}`,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: statusJsonSchema,
            maxOutputTokens: 4096,
          },
        })) as GeminiResponse;
        return this.resultFromText({
          text: response.text ?? JSON.stringify(response),
          raw: response,
          usage: usageFromGemini(response.usageMetadata),
          started,
          attempts: attempt,
          modelReported: response.modelVersion,
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
          message: `Gemini generation attempt ${attempt}`,
        });
        const response = (await this.client().models.generateContent({
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}`,
          config: { maxOutputTokens: 20000 },
        })) as GeminiResponse;
        return this.generationFromText({
          text: response.text ?? JSON.stringify(response),
          raw: response,
          usage: usageFromGemini(response.usageMetadata),
          started,
          attempts: attempt,
          modelReported: response.modelVersion,
        });
      },
      (error, attempt) =>
        classifyProviderError(this.id, this.provider, this.model, error, attempt, started),
    );
  }
}
