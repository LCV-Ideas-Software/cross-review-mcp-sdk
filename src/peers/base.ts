import type {
  AppConfig,
  GenerationResult,
  PeerCallContext,
  PeerId,
  PeerResult,
  TokenUsage,
} from "../core/types.js";
import { estimateCost } from "../core/cost.js";
import { decisionQualityFromStatus, parsePeerStatus } from "../core/status.js";
import { redact } from "../security/redact.js";

export abstract class BasePeerAdapter {
  abstract id: PeerId;
  abstract provider: string;
  abstract model: string;

  protected constructor(protected readonly config: AppConfig) {}

  private modelMatches(reported?: string): boolean | undefined {
    if (!reported) return undefined;
    const requestedModel = this.normalizeModelId(this.model);
    const reportedModel = this.normalizeModelId(reported);
    if (reportedModel === requestedModel) return true;
    return reportedModel.startsWith(`${requestedModel}-`);
  }

  private normalizeModelId(model: string): string {
    return model.trim().replace(/^models\//i, "");
  }

  protected shouldStreamTokens(context: PeerCallContext): boolean {
    return Boolean(context.stream_tokens && this.config.streaming.tokens);
  }

  protected emitTokenDelta(
    context: PeerCallContext,
    params: { phase: "review" | "generation"; delta: string; source?: string },
  ): void {
    if (!this.shouldStreamTokens(context) || !params.delta) return;
    const data: Record<string, unknown> = {
      phase: params.phase,
      provider: this.provider,
      model: this.model,
      source: params.source ?? "text",
      chars: params.delta.length,
    };
    if (this.config.streaming.include_text) {
      data.delta = redact(params.delta);
    }
    context.emit({
      type: "peer.token.delta",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: `${this.id} streamed ${params.delta.length} chars.`,
      data,
    });
  }

  protected emitTokenCompleted(
    context: PeerCallContext,
    params: { phase: "review" | "generation"; chars: number },
  ): void {
    if (!this.shouldStreamTokens(context)) return;
    context.emit({
      type: "peer.token.completed",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: `${this.id} completed token streaming.`,
      data: {
        phase: params.phase,
        provider: this.provider,
        model: this.model,
        chars: params.chars,
      },
    });
  }

  protected resultFromText(params: {
    text: string;
    raw: unknown;
    usage?: TokenUsage;
    started: number;
    attempts: number;
    modelReported?: string;
  }): PeerResult {
    const parsed = parsePeerStatus(params.text);
    const modelMatch = this.modelMatches(params.modelReported);
    const parserWarnings =
      modelMatch === false
        ? [
            ...parsed.parser_warnings,
            `reported model ${params.modelReported} did not match requested model ${this.model}`,
          ]
        : parsed.parser_warnings;
    return {
      peer: this.id,
      provider: this.provider,
      model: this.model,
      model_reported: params.modelReported,
      model_match: modelMatch,
      status: modelMatch === false ? null : parsed.status,
      structured: parsed.structured,
      text: params.text,
      raw: params.raw,
      usage: params.usage,
      cost: estimateCost(this.config, this.id, params.usage),
      latency_ms: Date.now() - params.started,
      attempts: params.attempts,
      parser_warnings: parserWarnings,
      decision_quality:
        modelMatch === false ? "failed" : decisionQualityFromStatus(parsed.status, parserWarnings),
    };
  }

  protected generationFromText(params: {
    text: string;
    raw: unknown;
    usage?: TokenUsage;
    started: number;
    attempts: number;
    modelReported?: string;
  }): GenerationResult {
    const modelMatch = this.modelMatches(params.modelReported);
    return {
      peer: this.id,
      provider: this.provider,
      model: this.model,
      model_reported: params.modelReported,
      model_match: modelMatch,
      text: params.text,
      raw: params.raw,
      usage: params.usage,
      cost: estimateCost(this.config, this.id, params.usage),
      latency_ms: Date.now() - params.started,
      attempts: params.attempts,
    };
  }

  protected systemPrompt(context: PeerCallContext): string {
    return [
      "You are a peer reviewer in cross-review-v2.",
      "Your job is to review the caller's work rigorously and independently.",
      "Do not rubber-stamp. Do not invent evidence.",
      "Unanimity is required: READY only when no blocking issue remains.",
      `Session: ${context.session_id}`,
      `Round: ${context.round}`,
      "Original task:",
      context.task,
    ].join("\n\n");
  }
}
