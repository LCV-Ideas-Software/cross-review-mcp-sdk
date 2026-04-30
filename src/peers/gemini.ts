import { GoogleGenAI, ThinkingLevel } from "@google/genai";
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

function geminiThinkingConfig(model: string): {
  includeThoughts: false;
  thinkingBudget?: number;
  thinkingLevel?: ThinkingLevel;
} {
  if (/gemini-3/i.test(model)) {
    return { includeThoughts: false, thinkingLevel: ThinkingLevel.HIGH };
  }
  return { includeThoughts: false, thinkingBudget: -1 };
}

export class GeminiAdapter extends BasePeerAdapter implements PeerAdapter {
  id: PeerId = "gemini";
  provider = "google";
  model: string;

  constructor(config: AppConfig, modelOverride?: string) {
    super(config);
    this.model = modelOverride ?? config.models.gemini;
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
        const params = {
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}\n\n${statusInstruction()}`,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: statusJsonSchema,
            maxOutputTokens: this.config.max_output_tokens,
            thinkingConfig: geminiThinkingConfig(this.model),
          },
        };
        if (this.shouldStreamTokens(context)) {
          const stream = await this.client().models.generateContentStream(params);
          let text = "";
          let last: GeminiResponse | undefined;
          for await (const chunk of stream as AsyncGenerator<GeminiResponse>) {
            last = chunk;
            const delta = chunk.text ?? "";
            text += delta;
            this.emitTokenDelta(context, {
              phase: "review",
              delta,
              source: "generateContentStream.text",
            });
          }
          this.emitTokenCompleted(context, { phase: "review", chars: text.length });
          return this.resultFromText({
            text: text || (last?.text ?? JSON.stringify(last ?? {})),
            raw: { streamed: true, provider: this.provider, model: last?.modelVersion },
            usage: usageFromGemini(last?.usageMetadata),
            started,
            attempts: attempt,
            modelReported: last?.modelVersion,
          });
        }
        const response = (await this.client().models.generateContent(params)) as GeminiResponse;
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
        const params = {
          model: this.model,
          contents: `${this.systemPrompt(context)}\n\n${userPrompt(prompt)}`,
          config: {
            maxOutputTokens: this.config.max_output_tokens,
            thinkingConfig: geminiThinkingConfig(this.model),
          },
        };
        if (this.shouldStreamTokens(context)) {
          const stream = await this.client().models.generateContentStream(params);
          let text = "";
          let last: GeminiResponse | undefined;
          for await (const chunk of stream as AsyncGenerator<GeminiResponse>) {
            last = chunk;
            const delta = chunk.text ?? "";
            text += delta;
            this.emitTokenDelta(context, {
              phase: "generation",
              delta,
              source: "generateContentStream.text",
            });
          }
          this.emitTokenCompleted(context, { phase: "generation", chars: text.length });
          return this.generationFromText({
            text: text || (last?.text ?? JSON.stringify(last ?? {})),
            raw: { streamed: true, provider: this.provider, model: last?.modelVersion },
            usage: usageFromGemini(last?.usageMetadata),
            started,
            attempts: attempt,
            modelReported: last?.modelVersion,
          });
        }
        const response = (await this.client().models.generateContent(params)) as GeminiResponse;
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
