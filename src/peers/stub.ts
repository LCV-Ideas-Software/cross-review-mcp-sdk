import type {
  AppConfig,
  GenerationResult,
  PeerAdapter,
  PeerCallContext,
  PeerId,
  PeerProbeResult,
  PeerResult,
} from "../core/types.js";
import { BasePeerAdapter } from "./base.js";

const PROVIDERS: Record<PeerId, string> = {
  codex: "stub-openai",
  claude: "stub-anthropic",
  gemini: "stub-google",
  deepseek: "stub-deepseek",
};

export class StubAdapter extends BasePeerAdapter implements PeerAdapter {
  provider: string;
  model: string;

  constructor(
    config: AppConfig,
    readonly id: PeerId,
    modelOverride?: string,
  ) {
    super(config);
    this.provider = PROVIDERS[id];
    this.model = modelOverride ?? `stub-${id}`;
  }

  private streamStubText(context: PeerCallContext, phase: "review" | "generation", text: string) {
    if (!this.shouldStreamTokens(context)) return;
    for (const delta of text.match(/.{1,32}/gs) ?? []) {
      this.emitTokenDelta(context, { phase, delta, source: "stub.chunk" });
    }
    this.emitTokenCompleted(context, { phase, chars: text.length });
  }

  async probe(): Promise<PeerProbeResult> {
    return {
      peer: this.id,
      provider: this.provider,
      model: this.model,
      available: true,
      auth_present: true,
      latency_ms: 0,
      model_selection: this.config.model_selection[this.id],
      message: "Stub enabled by CROSS_REVIEW_V2_STUB=1.",
    };
  }

  async call(prompt: string, context: PeerCallContext): Promise<PeerResult> {
    context.emit({
      type: "peer.call.started",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: "stub review",
    });
    if (context.signal?.aborted) {
      throw new Error("AbortError: stub call cancelled");
    }
    if (prompt.includes("FORCE_MODERATION_FAIL_UNRECOVERABLE")) {
      throw new Error("Invalid prompt: prompt flagged by moderation policy.");
    }
    if (
      prompt.includes("FORCE_MODERATION_FAIL") &&
      !prompt.includes("Compact Moderation-Safe Review")
    ) {
      throw new Error("Invalid prompt: prompt flagged by moderation policy.");
    }
    if (prompt.includes("FORCE_NETWORK_FAIL") && !this.model.includes("fallback")) {
      throw new Error("network fetch failed");
    }
    const text = prompt.includes("Cross Review - Decision Retry")
      ? JSON.stringify({
          status: "READY",
          summary: "Stub completed a full decision retry after an empty response.",
          confidence: "verified",
          evidence_sources: [],
          caller_requests: [],
          follow_ups: [],
        })
      : prompt.includes("Cross Review - Format Recovery")
        ? prompt.includes("FORCE_RECOVERY_FAIL")
          ? "Still no machine-readable status."
          : JSON.stringify({
              status: "READY",
              summary: "Stub recovered the previous unparseable response.",
              confidence: "verified",
              evidence_sources: [],
              caller_requests: [],
              follow_ups: [],
            })
        : prompt.includes("FORCE_BAD_FORMAT_UNRECOVERABLE")
          ? "I am READY, but this intentionally lacks JSON. FORCE_RECOVERY_FAIL"
          : prompt.includes("FORCE_EMPTY_REVIEW")
            ? ""
            : prompt.includes("FORCE_BAD_FORMAT")
              ? "I am READY, but this intentionally lacks the required machine-readable status object."
              : prompt.includes("FORCE_NOT_READY") || prompt.includes("FORCE_NEEDS_EVIDENCE")
                ? JSON.stringify({
                    status: prompt.includes("FORCE_NEEDS_EVIDENCE")
                      ? "NEEDS_EVIDENCE"
                      : "NOT_READY",
                    summary: "Stub detected a test marker.",
                    confidence: "verified",
                    evidence_sources: [],
                    caller_requests: ["Remove the test marker."],
                    follow_ups: [],
                  })
                : prompt.includes("FORCE_CANCEL_SLOW")
                  ? await new Promise<string>((resolve, reject) => {
                      const timer = setTimeout(
                        () =>
                          resolve(
                            JSON.stringify({
                              status: "READY",
                              summary: "Stub completed after a cancellable delay.",
                              confidence: "verified",
                              evidence_sources: [],
                              caller_requests: [],
                              follow_ups: [],
                            }),
                          ),
                        10_000,
                      );
                      context.signal?.addEventListener(
                        "abort",
                        () => {
                          clearTimeout(timer);
                          reject(new Error("AbortError: stub call cancelled"));
                        },
                        { once: true },
                      );
                    })
                  : JSON.stringify({
                      status: "READY",
                      summary: "Stub approved the test round.",
                      confidence: "verified",
                      evidence_sources: [],
                      caller_requests: [],
                      follow_ups: [],
                    });
    this.streamStubText(context, "review", text);
    return this.resultFromText({
      text,
      raw: { stub: true },
      usage: {
        input_tokens: prompt.length,
        output_tokens: text.length,
        total_tokens: prompt.length + text.length,
      },
      started: Date.now(),
      attempts: 1,
      modelReported: process.env.CROSS_REVIEW_V2_STUB_REPORTED_MODEL,
    });
  }

  async generate(prompt: string, context: PeerCallContext): Promise<GenerationResult> {
    context.emit({
      type: "peer.generate.started",
      session_id: context.session_id,
      round: context.round,
      peer: this.id,
      message: "stub generation",
    });
    const text = [
      "# Test Draft",
      "",
      "This text was generated by the stub only because CROSS_REVIEW_V2_STUB=1 is active.",
      "",
      prompt.slice(0, 1200),
    ].join("\n");
    this.streamStubText(context, "generation", text);
    return this.generationFromText({
      text,
      raw: { stub: true },
      usage: {
        input_tokens: prompt.length,
        output_tokens: text.length,
        total_tokens: prompt.length + text.length,
      },
      started: Date.now(),
      attempts: 1,
      modelReported: process.env.CROSS_REVIEW_V2_STUB_REPORTED_MODEL,
    });
  }
}
