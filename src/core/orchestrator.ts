import type {
  AppConfig,
  ConvergenceResult,
  ConvergenceScope,
  FallbackEvent,
  PeerAdapter,
  PeerFailure,
  PeerId,
  PeerProbeResult,
  PeerResult,
  ReviewRound,
  ReviewStatus,
  RuntimeEvent,
  SessionMeta,
} from "./types.js";
import { PEERS } from "./types.js";
import { checkConvergence } from "./convergence.js";
import { sessionReportMarkdown } from "./reports.js";
import { SessionStore } from "./session-store.js";
import { decisionQualityFromStatus } from "./status.js";
import { classifyProviderError } from "../peers/errors.js";
import { resolveBestModels } from "../peers/model-selection.js";
import { createAdapters, selectAdapters } from "../peers/registry.js";
import { redact } from "../security/redact.js";

export interface AskPeersInput {
  session_id?: string;
  task: string;
  draft: string;
  caller?: PeerId | "operator";
  caller_status?: ReviewStatus;
  peers?: PeerId[];
  signal?: AbortSignal;
}

export interface AskPeersOutput {
  session: SessionMeta;
  round: ReviewRound;
  converged: boolean;
}

export interface RunUntilUnanimousInput {
  session_id?: string;
  task: string;
  initial_draft?: string;
  lead_peer?: PeerId;
  peers?: PeerId[];
  max_rounds?: number;
  until_stopped?: boolean;
  max_cost_usd?: number;
  signal?: AbortSignal;
}

export interface RunUntilUnanimousOutput {
  session: SessionMeta;
  final_text?: string;
  converged: boolean;
  rounds: number;
}

function now(): string {
  return new Date().toISOString();
}

function emitNoop(_event: RuntimeEvent): void {
  // Intentionally empty. Callers can inject event sinks for logs, dashboards or MCP progress.
}

function safePromptText(value: string, maxLength = 4_000): string {
  const cleaned = redact(value).replace(/\r\n/g, "\n").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 3)}...`;
}

function safePromptList(values: string[] | undefined, maxItems = 8): string {
  if (!values?.length) return "-";
  return values
    .slice(0, maxItems)
    .map((value) => safePromptText(value, 300))
    .join("; ");
}

function limitBlock(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 80)}\n\n[Context compacted by prompt budget: ${value.length} chars -> ${maxLength} chars]`;
}

function summarizePriorRounds(meta: SessionMeta, config: AppConfig): string {
  if (!meta.rounds.length) return "No prior round.";
  const summary = meta.rounds
    .slice(-config.prompt.max_prior_rounds)
    .map((round) => {
      const peerLines = round.peers.map((peer) => {
        const summary = safePromptText(
          peer.structured?.summary ?? "No structured summary was returned.",
          700,
        );
        const requests = safePromptList(
          peer.structured?.caller_requests,
          config.prompt.max_peer_requests,
        );
        return [
          `- ${peer.peer}: ${peer.status ?? "NO_STATUS"} (${peer.decision_quality ?? "unknown"})`,
          `  summary: ${summary}`,
          `  requested changes: ${requests}`,
        ].join("\n");
      });
      const failureLines = round.rejected.map(
        (failure) =>
          `- ${failure.peer}: FAILURE ${failure.failure_class} - ${safePromptText(
            failure.message,
            500,
          )}`,
      );
      return [
        `Round ${round.round}: ${round.convergence.reason}`,
        ...peerLines,
        ...failureLines,
      ].join("\n");
    })
    .join("\n\n");
  return limitBlock(summary, config.prompt.max_history_chars);
}

function buildModerationSafeReviewPrompt(
  meta: SessionMeta,
  draft: string,
  config: AppConfig,
): string {
  return [
    "# Cross Review - Compact Moderation-Safe Review",
    "",
    "The previous provider request may have been rejected by an automated safety or moderation filter.",
    "Review this compact neutral prompt instead. Do not quote any sensitive text verbatim.",
    "If the compact context is insufficient to decide, return NEEDS_EVIDENCE with precise missing evidence.",
    "",
    "## Original Task (sanitized excerpt)",
    safePromptText(meta.task, Math.min(config.prompt.max_task_chars, 6_000)),
    "",
    "## Recent History (structured summary only)",
    summarizePriorRounds(meta, config),
    "",
    "## Draft Or Solution Under Review (sanitized excerpt)",
    safePromptText(draft, Math.min(config.prompt.max_draft_chars, 16_000)),
    "",
    "Decide whether any blocking issue remains.",
  ].join("\n");
}

function buildReviewPrompt(meta: SessionMeta, draft: string, config: AppConfig): string {
  return [
    "# Cross Review - Review Round",
    "",
    "## Original Task",
    safePromptText(meta.task, config.prompt.max_task_chars),
    "",
    "## Recent History",
    summarizePriorRounds(meta, config),
    "",
    "## Draft Or Solution Under Review",
    safePromptText(draft, config.prompt.max_draft_chars),
    "",
    "Review rigorously whether the draft or solution satisfies the task. Identify concrete blocking issues.",
  ].join("\n");
}

function buildRevisionPrompt(meta: SessionMeta, draft: string, config: AppConfig): string {
  return [
    "# Cross Review - Revision For Convergence",
    "",
    "Rewrite the solution considering every blocking issue and peer request.",
    "Do not ignore disagreements. Preserve what peers already accepted and fix what prevented unanimity.",
    "",
    "## Original Task",
    safePromptText(meta.task, config.prompt.max_task_chars),
    "",
    "## Recent History",
    summarizePriorRounds(meta, config),
    "",
    "## Previous Version",
    safePromptText(draft, config.prompt.max_draft_chars),
    "",
    "Return only the complete revised version, without meeting notes or external commentary.",
  ].join("\n");
}

function buildInitialDraftPrompt(task: string, config: AppConfig): string {
  return [
    "# Cross Review - First Draft",
    "",
    "Create a complete first version for the task below.",
    "The version will be submitted to unanimous peer review.",
    "",
    "## Task",
    safePromptText(task, config.prompt.max_task_chars),
  ].join("\n");
}

function buildFormatRecoveryPrompt(
  meta: SessionMeta,
  priorResponse: string,
  config: AppConfig,
): string {
  const boundedTask = safePromptText(meta.task, Math.min(config.prompt.max_task_chars, 4_000));
  const boundedResponse =
    priorResponse.length > 20_000 ? `${priorResponse.slice(0, 19_997)}...` : priorResponse;
  return [
    "# Cross Review - Format Recovery",
    "",
    "Your previous peer-review response could not be parsed by the machine-readable status parser.",
    "Do not re-review the artifact from scratch unless your previous answer was incomplete.",
    "Use your previous response as the primary source of truth for the recovered decision.",
    "If the previous response does not contain a clear decision, use NEEDS_EVIDENCE.",
    "Recover your own decision as one valid JSON object using the required response schema.",
    "",
    "## Original Task",
    boundedTask,
    "",
    "## Previous Unparseable Response",
    boundedResponse,
  ].join("\n");
}

function uniquePeers(peers: PeerId[]): PeerId[] {
  return [...new Set(peers)];
}

function isSubset(subset: PeerId[], superset: PeerId[]): boolean {
  return subset.every((peer) => superset.includes(peer));
}

function resolveQuorumPeers(session: SessionMeta, selectedPeers: PeerId[]): PeerId[] {
  const priorScope = session.convergence_scope?.expected_peers ?? [];
  if (priorScope.length > selectedPeers.length && isSubset(selectedPeers, priorScope)) {
    return priorScope;
  }
  return selectedPeers;
}

function latestPeerResultsForQuorum(
  session: SessionMeta,
  currentPeers: PeerResult[],
  quorumPeers: PeerId[],
): PeerResult[] {
  const latest = new Map<PeerId, PeerResult>();
  for (const round of session.rounds) {
    for (const peer of round.peers) {
      if (quorumPeers.includes(peer.peer)) latest.set(peer.peer, peer);
    }
  }
  for (const peer of currentPeers) {
    if (quorumPeers.includes(peer.peer)) latest.set(peer.peer, peer);
  }
  return quorumPeers
    .map((peer) => latest.get(peer))
    .filter((peer): peer is PeerResult => Boolean(peer));
}

function silentModelDowngradeFailure(result: PeerResult): PeerFailure {
  const reported = result.model_reported ?? "unknown";
  return {
    peer: result.peer,
    provider: result.provider,
    model: result.model,
    failure_class: "silent_model_downgrade",
    message: `Provider returned model "${reported}" while "${result.model}" was requested.`,
    retryable: false,
    attempts: result.attempts,
    latency_ms: result.latency_ms,
  };
}

function unparseableAfterRecoveryFailure(result: PeerResult): PeerFailure {
  return {
    peer: result.peer,
    provider: result.provider,
    model: result.model,
    failure_class: "unparseable_after_recovery",
    message:
      "Peer response still did not contain a parseable status after one automatic format-recovery retry.",
    retryable: false,
    attempts: result.attempts,
    latency_ms: result.latency_ms,
  };
}

function budgetLimit(config: AppConfig, inputLimit?: number): number | undefined {
  return inputLimit ?? config.budget.max_session_cost_usd;
}

function budgetExceeded(session: SessionMeta, limit?: number): boolean {
  const total = session.totals.cost.total_cost;
  return limit != null && total != null && total > limit;
}

function estimatedPeerRoundCost(
  config: AppConfig,
  peers: PeerId[],
  prompt: string,
): number | undefined {
  let total = 0;
  for (const peer of peers) {
    const rate = config.cost_rates[peer];
    if (!rate) return undefined;
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = 4096;
    total += (inputTokens / 1_000_000) * rate.input_per_million;
    total += (outputTokens / 1_000_000) * rate.output_per_million;
  }
  return total;
}

function budgetPreflightFailure(
  peer: PeerId,
  provider: string,
  model: string,
  message: string,
): PeerFailure {
  return {
    peer,
    provider,
    model,
    failure_class: "budget_preflight",
    message,
    retryable: false,
    attempts: 0,
    latency_ms: 0,
  };
}

function cancelledConvergence(peers: PeerId[]): ConvergenceResult {
  return {
    converged: false,
    reason: "session_cancelled",
    ready_peers: [],
    not_ready_peers: [],
    needs_evidence_peers: [],
    rejected_peers: peers,
    decision_quality: Object.fromEntries(
      peers.map((peer) => [peer, "failed"]),
    ) as ConvergenceResult["decision_quality"],
    blocking_details: ["Session was cancelled before all peers completed."],
  };
}

function cancellationFailure(
  peer: PeerId,
  provider: string,
  model: string,
  reason: string,
): PeerFailure {
  return {
    peer,
    provider,
    model,
    failure_class: "cancelled",
    message: reason,
    retryable: false,
    attempts: 0,
    latency_ms: 0,
  };
}

interface PeerCallOutcome {
  adapter: PeerAdapter;
  result?: PeerResult;
  failure?: PeerFailure;
}

export class CrossReviewOrchestrator {
  readonly store: SessionStore;
  adapters: Record<PeerId, PeerAdapter>;

  constructor(
    readonly config: AppConfig,
    private readonly emit: (event: RuntimeEvent) => void = emitNoop,
  ) {
    this.store = new SessionStore(config);
    this.adapters = createAdapters(config);
  }

  async probeAll(): Promise<PeerProbeResult[]> {
    await resolveBestModels(this.config);
    const adapters = createAdapters(this.config);
    return Promise.all(selectAdapters(adapters).map((adapter) => adapter.probe()));
  }

  async initSession(task: string, caller: PeerId | "operator" = "operator"): Promise<SessionMeta> {
    const snapshot = await this.probeAll();
    const meta = this.store.init(task, caller, snapshot);
    this.emit({
      type: "session.created",
      session_id: meta.session_id,
      message: "Session created.",
      data: { caller },
    });
    return meta;
  }

  private isCancelled(sessionId: string, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted) || this.store.isCancellationRequested(sessionId);
  }

  private fallbackAdapters(adapter: PeerAdapter): PeerAdapter[] {
    const models = this.config.fallback_models[adapter.id] ?? [];
    return models
      .filter((model) => model && model !== adapter.model)
      .map((model) => createAdapters(this.config, { [adapter.id]: model })[adapter.id]);
  }

  private recordFallback(
    sessionId: string,
    adapter: PeerAdapter,
    fallback: PeerAdapter,
    reason: string,
  ): FallbackEvent {
    const event: FallbackEvent = {
      peer: adapter.id,
      provider: adapter.provider,
      from_model: adapter.model,
      to_model: fallback.model,
      reason,
      ts: now(),
    };
    this.store.appendFallbackEvent(sessionId, event);
    this.emit({
      type: "peer.fallback.started",
      session_id: sessionId,
      peer: adapter.id,
      message: `Retrying ${adapter.id} with fallback model ${fallback.model}.`,
      data: { from_model: adapter.model, to_model: fallback.model, reason },
    });
    return event;
  }

  private async callPeerForReview(
    adapter: PeerAdapter,
    prompt: string,
    moderationSafePrompt: string,
    context: Parameters<PeerAdapter["call"]>[1],
  ): Promise<PeerCallOutcome> {
    const started = Date.now();
    if (this.isCancelled(context.session_id, context.signal)) {
      return {
        adapter,
        failure: cancellationFailure(
          adapter.id,
          adapter.provider,
          adapter.model,
          "Session cancellation was requested before peer call.",
        ),
      };
    }
    try {
      return { adapter, result: await adapter.call(prompt, context) };
    } catch (error) {
      const failure = classifyProviderError(
        adapter.id,
        adapter.provider,
        adapter.model,
        error,
        this.config.retry.max_attempts,
        started,
      );
      if (failure.failure_class !== "prompt_flagged_by_moderation") {
        if (failure.retryable) {
          let fallbackWasTried = false;
          let lastFallbackFailure: PeerFailure | undefined;
          for (const fallback of this.fallbackAdapters(adapter)) {
            fallbackWasTried = true;
            const fallbackEvent = this.recordFallback(
              context.session_id,
              adapter,
              fallback,
              failure.failure_class,
            );
            try {
              const fallbackResult = await fallback.call(prompt, context);
              const parserWarnings = [
                ...fallbackResult.parser_warnings,
                `fallback_model_used:${adapter.model}->${fallback.model}`,
              ];
              return {
                adapter: fallback,
                result: {
                  ...fallbackResult,
                  attempts: fallbackResult.attempts + failure.attempts,
                  parser_warnings: parserWarnings,
                  decision_quality: decisionQualityFromStatus(
                    fallbackResult.status,
                    parserWarnings,
                  ),
                  fallback: fallbackEvent,
                },
              };
            } catch (fallbackError) {
              const fallbackFailure = classifyProviderError(
                fallback.id,
                fallback.provider,
                fallback.model,
                fallbackError,
                this.config.retry.max_attempts,
                started,
              );
              lastFallbackFailure = fallbackFailure;
              if (!fallbackFailure.retryable) {
                return { adapter: fallback, failure: fallbackFailure };
              }
            }
          }
          if (fallbackWasTried) {
            return {
              adapter,
              failure: {
                ...failure,
                failure_class: "fallback_exhausted",
                message: `Primary model failed with ${failure.failure_class}; fallback models were attempted and exhausted. Last fallback: ${
                  lastFallbackFailure?.message ?? "unknown"
                }`,
                retryable: false,
              },
            };
          }
        }
        return { adapter, failure };
      }

      this.emit({
        type: "peer.moderation_recovery.started",
        session_id: context.session_id,
        round: context.round,
        peer: adapter.id,
        message:
          "Provider rejected the prompt; retrying once with a compact sanitized review prompt.",
        data: { failure_class: failure.failure_class },
      });

      try {
        const recovered = await adapter.call(moderationSafePrompt, context);
        const parserWarnings = [...recovered.parser_warnings, "moderation_safe_retry_succeeded"];
        return {
          adapter,
          result: {
            ...recovered,
            attempts: recovered.attempts + failure.attempts,
            parser_warnings: parserWarnings,
            decision_quality: decisionQualityFromStatus(recovered.status, parserWarnings),
          },
        };
      } catch (retryError) {
        const retryFailure = classifyProviderError(
          adapter.id,
          adapter.provider,
          adapter.model,
          retryError,
          this.config.retry.max_attempts,
          started,
        );
        return {
          adapter,
          failure: {
            ...retryFailure,
            failure_class:
              retryFailure.failure_class === "prompt_flagged_by_moderation"
                ? "prompt_flagged_by_moderation"
                : retryFailure.failure_class,
            message: `Prompt was rejected and the compact sanitized retry also failed: ${retryFailure.message}`,
            recovery_hint: "reformulate_and_retry",
            reformulation_advice:
              "Compact the prompt, summarize verbose peer content, avoid quoting flagged text, and retry with the same technical intent.",
            attempts: failure.attempts + retryFailure.attempts,
          },
        };
      }
    }
  }

  async askPeers(input: AskPeersInput): Promise<AskPeersOutput> {
    const caller = input.caller ?? "operator";
    const callerStatus = input.caller_status ?? "READY";
    const session = input.session_id
      ? this.store.read(input.session_id)
      : await this.initSession(input.task, caller);
    const roundNumber = session.rounds.length + 1;
    const startedAt = now();
    const selectedPeers = uniquePeers(input.peers?.length ? input.peers : [...PEERS]);
    const quorumPeers = resolveQuorumPeers(session, selectedPeers);
    const isRecoveryRound = quorumPeers.length > selectedPeers.length;
    const adapters = createAdapters(this.config);
    const convergenceScope: ConvergenceScope = {
      caller,
      caller_status: callerStatus,
      expected_peers: quorumPeers,
      reviewer_peers: selectedPeers,
      lead_peer: caller === "operator" ? undefined : caller,
    };
    const draftFile = this.store.saveDraft(session.session_id, roundNumber, input.draft);
    const prompt = buildReviewPrompt(session, input.draft, this.config);
    const moderationSafePrompt = buildModerationSafeReviewPrompt(session, input.draft, this.config);
    const promptFile = this.store.savePrompt(session.session_id, roundNumber, prompt);
    this.store.markInFlight(session.session_id, {
      round: roundNumber,
      peers: selectedPeers,
      started_at: startedAt,
      scope: convergenceScope,
    });

    this.emit({
      type: "round.started",
      session_id: session.session_id,
      round: roundNumber,
      message: "Review round started.",
      data: { peers: selectedPeers },
    });

    const roundPreflightLimit = this.config.budget.preflight_max_round_cost_usd;
    const sessionPreflightLimit = budgetLimit(this.config);
    const preflightEstimate = estimatedPeerRoundCost(this.config, selectedPeers, prompt);
    const currentSessionCost = session.totals.cost.total_cost ?? 0;
    const projectedSessionCost =
      preflightEstimate == null ? undefined : currentSessionCost + preflightEstimate;
    const message =
      preflightEstimate == null && (roundPreflightLimit != null || sessionPreflightLimit != null)
        ? "Budget preflight cannot estimate this round because one or more peers have no configured rate card."
        : roundPreflightLimit != null &&
            preflightEstimate != null &&
            preflightEstimate > roundPreflightLimit
          ? `Budget preflight blocked the round: estimated round cost $${preflightEstimate.toFixed(
              6,
            )} exceeds round limit $${roundPreflightLimit.toFixed(6)}.`
          : sessionPreflightLimit != null &&
              projectedSessionCost != null &&
              projectedSessionCost > sessionPreflightLimit
            ? `Budget preflight blocked the round: projected session cost $${projectedSessionCost.toFixed(
                6,
              )} exceeds session limit $${sessionPreflightLimit.toFixed(6)}.`
            : undefined;
    if (message) {
      const rejected = selectAdapters(adapters, selectedPeers).map((adapter) =>
        budgetPreflightFailure(adapter.id, adapter.provider, adapter.model, message),
      );
      for (const failure of rejected) {
        this.store.savePeerFailure(session.session_id, roundNumber, failure);
      }
      const convergence = checkConvergence(selectedPeers, callerStatus, [], rejected);
      const round = this.store.appendRound(session.session_id, {
        caller_status: callerStatus,
        draft_file: draftFile,
        prompt_file: promptFile,
        peers: [],
        rejected,
        convergence,
        convergence_scope: convergenceScope,
        started_at: startedAt,
      });
      const updated = this.store.finalize(session.session_id, "max-rounds", "budget_preflight");
      this.emit({
        type: "round.blocked.budget_preflight",
        session_id: session.session_id,
        round: roundNumber,
        message,
        data: {
          estimated_round_cost_usd: preflightEstimate,
          current_session_cost_usd: currentSessionCost,
          projected_session_cost_usd: projectedSessionCost,
          round_limit_usd: roundPreflightLimit,
          session_limit_usd: sessionPreflightLimit,
        },
      });
      return { session: updated, round, converged: false };
    }

    if (this.isCancelled(session.session_id, input.signal)) {
      const rejected = selectAdapters(adapters, selectedPeers).map((adapter) =>
        cancellationFailure(
          adapter.id,
          adapter.provider,
          adapter.model,
          "Session cancellation was requested before this round started.",
        ),
      );
      const round = this.store.appendRound(session.session_id, {
        caller_status: callerStatus,
        draft_file: draftFile,
        prompt_file: promptFile,
        peers: [],
        rejected,
        convergence: cancelledConvergence(selectedPeers),
        convergence_scope: convergenceScope,
        started_at: startedAt,
      });
      const updated = this.store.markCancelled(session.session_id, "session_cancelled");
      return { session: updated, round, converged: false };
    }

    const settled = await Promise.all(
      selectAdapters(adapters, selectedPeers).map((adapter) =>
        this.callPeerForReview(adapter, prompt, moderationSafePrompt, {
          session_id: session.session_id,
          round: roundNumber,
          task: session.task,
          signal: input.signal,
          stream: this.config.streaming.events,
          emit: this.emit,
        }),
      ),
    );

    const peers: PeerResult[] = [];
    const rejected: PeerFailure[] = [];

    for (const item of settled) {
      const { adapter } = item;
      if (item.result) {
        let peerResult = item.result;
        if (peerResult.status == null && peerResult.model_match !== false) {
          this.store.savePeerResult(
            session.session_id,
            roundNumber,
            peerResult,
            "unparsed-response",
          );
          this.emit({
            type: "peer.format_recovery.started",
            session_id: session.session_id,
            round: roundNumber,
            peer: peerResult.peer,
            message:
              "Peer response did not include a parseable status; requesting format recovery.",
          });
          try {
            const recovered = await adapter.call(
              buildFormatRecoveryPrompt(session, peerResult.text, this.config),
              {
                session_id: session.session_id,
                round: roundNumber,
                task: session.task,
                signal: input.signal,
                emit: this.emit,
              },
            );
            const parserWarnings = [
              ...peerResult.parser_warnings.map((warning) => `original:${warning}`),
              ...recovered.parser_warnings,
              recovered.status
                ? "format_recovery_retry_succeeded"
                : "format_recovery_retry_returned_no_status",
            ];
            peerResult = {
              ...recovered,
              attempts: peerResult.attempts + recovered.attempts,
              parser_warnings: parserWarnings,
              decision_quality: decisionQualityFromStatus(recovered.status, parserWarnings),
            };
            if (peerResult.status == null) {
              const failure = unparseableAfterRecoveryFailure(peerResult);
              rejected.push(failure);
              this.store.savePeerFailure(session.session_id, roundNumber, failure);
            }
          } catch (error) {
            const failure = classifyProviderError(
              adapter.id,
              adapter.provider,
              adapter.model,
              error,
              this.config.retry.max_attempts,
              Date.parse(startedAt),
            );
            rejected.push(failure);
            this.store.savePeerFailure(session.session_id, roundNumber, failure);
          }
        }
        peers.push(peerResult);
        this.store.savePeerResult(session.session_id, roundNumber, peerResult);
        if (peerResult.model_match === false) {
          const failure = silentModelDowngradeFailure(peerResult);
          rejected.push(failure);
          this.store.savePeerFailure(session.session_id, roundNumber, failure);
        }
      } else if (item.failure) {
        const failure = item.failure;
        rejected.push(failure);
        this.store.savePeerFailure(session.session_id, roundNumber, failure);
      }
    }

    const latestRoundConvergence = checkConvergence(selectedPeers, callerStatus, peers, rejected);
    const quorumPeerResults = isRecoveryRound
      ? latestPeerResultsForQuorum(session, peers, quorumPeers)
      : peers;
    const quorumConvergence = isRecoveryRound
      ? checkConvergence(quorumPeers, callerStatus, quorumPeerResults, rejected)
      : latestRoundConvergence;
    const convergence = {
      ...quorumConvergence,
      reason:
        isRecoveryRound && quorumConvergence.converged
          ? "session quorum recovered across prior rounds and current recovery round"
          : quorumConvergence.reason,
      latest_round_converged: latestRoundConvergence.converged,
      session_quorum_converged: quorumConvergence.converged,
      recovery_converged: isRecoveryRound && quorumConvergence.converged,
      quorum_peers: quorumPeers,
    };
    const round = this.store.appendRound(session.session_id, {
      caller_status: callerStatus,
      draft_file: draftFile,
      prompt_file: promptFile,
      peers,
      rejected,
      convergence,
      convergence_scope: convergenceScope,
      started_at: startedAt,
    });
    let updated = this.store.read(session.session_id);
    if (convergence.converged) {
      this.store.saveFinal(session.session_id, input.draft);
      updated = this.store.finalize(
        session.session_id,
        "converged",
        convergence.recovery_converged ? "recovered_unanimity" : "unanimous_ready",
      );
    }
    this.store.saveReport(
      session.session_id,
      sessionReportMarkdown(
        this.store.read(session.session_id),
        this.store.readEvents(session.session_id),
      ),
    );
    this.emit({
      type: "round.completed",
      session_id: session.session_id,
      round: round.round,
      message: convergence.reason,
      data: { converged: convergence.converged },
    });
    return { session: updated, round, converged: convergence.converged };
  }

  async runUntilUnanimous(input: RunUntilUnanimousInput): Promise<RunUntilUnanimousOutput> {
    const leadPeer = input.lead_peer ?? "codex";
    const maxRounds = input.until_stopped
      ? Number.MAX_SAFE_INTEGER
      : input.max_rounds && input.max_rounds > 0
        ? input.max_rounds
        : 8;
    const costLimit = budgetLimit(this.config, input.max_cost_usd);
    const selectedPeers = input.peers?.length ? input.peers : [...PEERS];
    let session = input.session_id
      ? this.store.read(input.session_id)
      : await this.initSession(input.task, leadPeer);
    const adapters = createAdapters(this.config);
    const reviewerPeers = selectedPeers.filter((peer) => peer !== leadPeer);
    let draft = input.initial_draft;

    if (this.config.budget.require_rates_for_budget && costLimit != null) {
      const missingRates = selectedPeers.filter((peer) => !this.config.cost_rates[peer]);
      if (missingRates.length) {
        this.store.finalize(session.session_id, "max-rounds", "budget_requires_rates");
        this.emit({
          type: "session.blocked.budget_requires_rates",
          session_id: session.session_id,
          message: "Budget limit requires configured rate cards for all selected peers.",
          data: { missing_rates: missingRates },
        });
        return {
          session: this.store.read(session.session_id),
          final_text: draft,
          converged: false,
          rounds: 0,
        };
      }
    }

    if (!draft) {
      if (this.isCancelled(session.session_id, input.signal)) {
        this.store.markCancelled(session.session_id, "session_cancelled");
        return {
          session: this.store.read(session.session_id),
          converged: false,
          rounds: 0,
        };
      }
      const generation = await adapters[leadPeer].generate(
        buildInitialDraftPrompt(input.task, this.config),
        {
          session_id: session.session_id,
          round: 0,
          task: input.task,
          signal: input.signal,
          stream: this.config.streaming.events,
          emit: this.emit,
        },
      );
      this.store.saveGeneration(session.session_id, 0, generation, "initial-draft");
      draft = generation.text;
    }

    for (let round = 1; round <= maxRounds; round++) {
      if (this.isCancelled(session.session_id, input.signal)) {
        this.store.markCancelled(session.session_id, "session_cancelled");
        return {
          session: this.store.read(session.session_id),
          final_text: draft,
          converged: false,
          rounds: round - 1,
        };
      }
      const result = await this.askPeers({
        session_id: session.session_id,
        task: input.task,
        draft,
        caller: leadPeer,
        caller_status: "READY",
        peers: reviewerPeers.length ? reviewerPeers : selectedPeers,
        signal: input.signal,
      });
      session = this.store.read(session.session_id);
      if (result.converged) {
        return {
          session: this.store.read(session.session_id),
          final_text: draft,
          converged: true,
          rounds: round,
        };
      }

      if (budgetExceeded(session, costLimit)) {
        this.store.finalize(session.session_id, "max-rounds", "budget_exceeded");
        return {
          session: this.store.read(session.session_id),
          final_text: draft,
          converged: false,
          rounds: round,
        };
      }

      if (round < maxRounds) {
        const generation = await adapters[leadPeer].generate(
          buildRevisionPrompt(session, draft, this.config),
          {
            session_id: session.session_id,
            round,
            task: input.task,
            signal: input.signal,
            stream: this.config.streaming.events,
            emit: this.emit,
          },
        );
        this.store.saveGeneration(session.session_id, round, generation, "revision");
        draft = generation.text;
      }
    }

    this.store.finalize(session.session_id, "max-rounds", "max_rounds_without_unanimity");
    return {
      session: this.store.read(session.session_id),
      final_text: draft,
      converged: false,
      rounds: maxRounds,
    };
  }
}
