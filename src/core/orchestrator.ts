import type {
  AppConfig,
  ConvergenceScope,
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
import { SessionStore } from "./session-store.js";
import { classifyProviderError } from "../peers/errors.js";
import { resolveBestModels } from "../peers/model-selection.js";
import { createAdapters, selectAdapters } from "../peers/registry.js";

export interface AskPeersInput {
  session_id?: string;
  task: string;
  draft: string;
  caller?: PeerId | "operator";
  caller_status?: ReviewStatus;
  peers?: PeerId[];
}

export interface AskPeersOutput {
  session: SessionMeta;
  round: ReviewRound;
  converged: boolean;
}

export interface RunUntilUnanimousInput {
  task: string;
  initial_draft?: string;
  lead_peer?: PeerId;
  peers?: PeerId[];
  max_rounds?: number;
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

function summarizePriorRounds(meta: SessionMeta): string {
  if (!meta.rounds.length) return "No prior round.";
  return meta.rounds
    .slice(-5)
    .map((round) => {
      const peerLines = round.peers.map((peer) => {
        const summary = peer.structured?.summary ?? peer.text.slice(0, 500);
        return `- ${peer.peer}: ${peer.status ?? "NO_STATUS"} - ${summary}`;
      });
      const failureLines = round.rejected.map(
        (failure) => `- ${failure.peer}: FAILURE ${failure.failure_class} - ${failure.message}`,
      );
      return [
        `Round ${round.round}: ${round.convergence.reason}`,
        ...peerLines,
        ...failureLines,
      ].join("\n");
    })
    .join("\n\n");
}

function buildReviewPrompt(meta: SessionMeta, draft: string): string {
  return [
    "# Cross Review - Review Round",
    "",
    "## Original Task",
    meta.task,
    "",
    "## Recent History",
    summarizePriorRounds(meta),
    "",
    "## Draft Or Solution Under Review",
    draft,
    "",
    "Review rigorously whether the draft or solution satisfies the task. Identify concrete blocking issues.",
  ].join("\n");
}

function buildRevisionPrompt(meta: SessionMeta, draft: string): string {
  return [
    "# Cross Review - Revision For Convergence",
    "",
    "Rewrite the solution considering every blocking issue and peer request.",
    "Do not ignore disagreements. Preserve what peers already accepted and fix what prevented unanimity.",
    "",
    "## Original Task",
    meta.task,
    "",
    "## Recent History",
    summarizePriorRounds(meta),
    "",
    "## Previous Version",
    draft,
    "",
    "Return only the complete revised version, without meeting notes or external commentary.",
  ].join("\n");
}

function buildInitialDraftPrompt(task: string): string {
  return [
    "# Cross Review - First Draft",
    "",
    "Create a complete first version for the task below.",
    "The version will be submitted to unanimous peer review.",
    "",
    "## Task",
    task,
  ].join("\n");
}

function buildFormatRecoveryPrompt(meta: SessionMeta, priorResponse: string): string {
  const boundedTask = meta.task.length > 4_000 ? `${meta.task.slice(0, 3_997)}...` : meta.task;
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
    const prompt = buildReviewPrompt(session, input.draft);
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

    const settled = await Promise.allSettled(
      selectAdapters(adapters, selectedPeers).map((adapter) =>
        adapter.call(prompt, {
          session_id: session.session_id,
          round: roundNumber,
          task: session.task,
          emit: this.emit,
        }),
      ),
    );

    const peers: PeerResult[] = [];
    const rejected: PeerFailure[] = [];

    for (let index = 0; index < settled.length; index++) {
      const item = settled[index];
      const adapter = adapters[selectedPeers[index]];
      if (item.status === "fulfilled") {
        let peerResult = item.value;
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
              buildFormatRecoveryPrompt(session, peerResult.text),
              {
                session_id: session.session_id,
                round: roundNumber,
                task: session.task,
                emit: this.emit,
              },
            );
            peerResult = {
              ...recovered,
              attempts: peerResult.attempts + recovered.attempts,
              parser_warnings: [
                ...peerResult.parser_warnings.map((warning) => `original:${warning}`),
                ...recovered.parser_warnings,
                recovered.status
                  ? "format_recovery_retry_succeeded"
                  : "format_recovery_retry_returned_no_status",
              ],
            };
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
      } else {
        const failure = classifyProviderError(
          adapter.id,
          adapter.provider,
          adapter.model,
          item.reason,
          this.config.retry.max_attempts,
          Date.parse(startedAt),
        );
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
    const maxRounds = input.max_rounds && input.max_rounds > 0 ? input.max_rounds : 8;
    const selectedPeers = input.peers?.length ? input.peers : [...PEERS];
    let session = await this.initSession(input.task, leadPeer);
    const adapters = createAdapters(this.config);
    const reviewerPeers = selectedPeers.filter((peer) => peer !== leadPeer);
    let draft = input.initial_draft;

    if (!draft) {
      const generation = await adapters[leadPeer].generate(buildInitialDraftPrompt(input.task), {
        session_id: session.session_id,
        round: 0,
        task: input.task,
        emit: this.emit,
      });
      this.store.saveGeneration(session.session_id, 0, generation, "initial-draft");
      draft = generation.text;
    }

    for (let round = 1; round <= maxRounds; round++) {
      const result = await this.askPeers({
        session_id: session.session_id,
        task: input.task,
        draft,
        caller: leadPeer,
        caller_status: "READY",
        peers: reviewerPeers.length ? reviewerPeers : selectedPeers,
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

      if (round < maxRounds) {
        const generation = await adapters[leadPeer].generate(buildRevisionPrompt(session, draft), {
          session_id: session.session_id,
          round,
          task: input.task,
          emit: this.emit,
        });
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
