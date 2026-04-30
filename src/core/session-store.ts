import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  ConvergenceResult,
  ConvergenceScope,
  GenerationResult,
  GenerationArtifact,
  PeerFailure,
  PeerId,
  PeerProbeResult,
  PeerResult,
  RuntimeEvent,
  RuntimeMetrics,
  SessionEvent,
  ReviewRound,
  ReviewStatus,
  SessionMeta,
} from "./types.js";
import { mergeCost, mergeUsage } from "./cost.js";
import { redact } from "../security/redact.js";

function now(): string {
  return new Date().toISOString();
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, redact(`${JSON.stringify(data, null, 2)}\n`), "utf8");
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function safeFilePart(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "evidence";
}

function timestampFilePart(): string {
  return now().replace(/[:.]/g, "-");
}

export class SessionStore {
  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(this.sessionsDir(), { recursive: true });
  }

  sessionsDir(): string {
    return path.join(this.config.data_dir, "sessions");
  }

  sessionDir(sessionId: string): string {
    this.assertSessionId(sessionId);
    const sessionsRoot = fs.realpathSync(this.sessionsDir());
    const candidate = path.resolve(sessionsRoot, sessionId);
    const containedCandidate = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
    if (!this.isPathContained(sessionsRoot, containedCandidate)) {
      throw new Error(`session path escapes data directory: ${sessionId}`);
    }
    return containedCandidate;
  }

  metaPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "meta.json");
  }

  eventsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "events.ndjson");
  }

  assertSessionId(sessionId: string): void {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId)) {
      throw new Error(`invalid session_id: ${sessionId}`);
    }
  }

  private isPathContained(parent: string, target: string): boolean {
    const relative = path.relative(parent, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private sleepSync(ms: number): void {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
  }

  private totalsFor(meta: SessionMeta): SessionMeta["totals"] {
    const peerResults = meta.rounds.flatMap((round) => round.peers);
    const generations = meta.generation_files ?? [];
    return {
      usage: mergeUsage([
        ...peerResults.map((peer) => peer.usage),
        ...generations.map((generation) => generation.usage),
      ]),
      cost: mergeCost([
        ...peerResults.map((peer) => peer.cost),
        ...generations.map((generation) => generation.cost),
      ]),
    };
  }

  private withSessionLock<T>(sessionId: string, fn: () => T): T {
    const dir = this.sessionDir(sessionId);
    const lockPath = path.join(dir, ".lock");
    const timeoutAt = Date.now() + 30_000;
    while (true) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquired_at: now() }));
        fs.closeSync(fd);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lock = readJson<{ pid?: number; acquired_at?: string }>(lockPath);
          const age = lock.acquired_at ? Date.now() - Date.parse(lock.acquired_at) : Infinity;
          if (!lock.pid || age > 120_000 || !this.processAlive(lock.pid)) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= timeoutAt) {
          throw new Error(`timed out waiting for session lock: ${sessionId}`, { cause: error });
        }
        this.sleepSync(100);
      }
    }

    try {
      return fn();
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  }

  init(task: string, caller: PeerId | "operator", snapshot: PeerProbeResult[]): SessionMeta {
    const session_id = crypto.randomUUID();
    const meta: SessionMeta = {
      session_id,
      version: this.config.version,
      created_at: now(),
      updated_at: now(),
      task,
      caller,
      capability_snapshot: snapshot,
      convergence_health: {
        state: "idle",
        last_event_at: now(),
        detail: "Session initialized.",
      },
      rounds: [],
      totals: {
        usage: {},
        cost: { currency: "USD", estimated: false, source: "unknown-rate" },
      },
    };
    fs.mkdirSync(path.join(this.sessionDir(session_id), "agent-runs"), { recursive: true });
    writeJson(this.metaPath(session_id), meta);
    fs.writeFileSync(path.join(this.sessionDir(session_id), "task.md"), task, "utf8");
    return meta;
  }

  markInFlight(
    sessionId: string,
    params: {
      round: number;
      peers: PeerId[];
      started_at: string;
      scope: ConvergenceScope;
    },
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.in_flight = {
        round: params.round,
        peers: params.peers,
        started_at: params.started_at,
        status: "running",
      };
      meta.convergence_scope = params.scope;
      meta.convergence_health = {
        state: "running",
        last_event_at: now(),
        detail: `Round ${params.round} is running.`,
      };
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  read(sessionId: string): SessionMeta {
    return readJson<SessionMeta>(this.metaPath(sessionId));
  }

  appendEvent(event: RuntimeEvent): void {
    const sessionId = event.session_id;
    if (!sessionId) return;
    try {
      this.withSessionLock(sessionId, () => {
        const file = this.eventsPath(sessionId);
        let seq = 1;
        try {
          seq = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length + 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        fs.appendFileSync(
          file,
          `${JSON.stringify({ ...event, seq, ts: event.ts ?? now() })}\n`,
          "utf8",
        );
      });
    } catch {
      // Event persistence must never break provider calls or MCP responses.
    }
  }

  readEvents(sessionId: string, sinceSeq = 0): SessionEvent[] {
    const file = this.eventsPath(sessionId);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => ({ seq: index + 1, ...JSON.parse(line) }) as SessionEvent)
      .filter((event) => event.seq > sinceSeq);
  }

  list(): SessionMeta[] {
    if (!fs.existsSync(this.sessionsDir())) return [];
    return fs
      .readdirSync(this.sessionsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.sessionsDir(), entry.name, "meta.json"))
      .filter((file) => fs.existsSync(file))
      .map((file) => readJson<SessionMeta>(file))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  savePrompt(sessionId: string, round: number, prompt: string): string {
    const file = path.join(this.sessionDir(sessionId), "agent-runs", `round-${round}-prompt.md`);
    fs.writeFileSync(file, redact(prompt), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  saveDraft(sessionId: string, round: number, draft: string): string {
    const file = path.join(this.sessionDir(sessionId), "agent-runs", `round-${round}-draft.md`);
    fs.writeFileSync(file, redact(draft), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  saveGeneration(
    sessionId: string,
    round: number,
    result: GenerationResult,
    label = "generation",
  ): string {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${result.peer}-${label}.json`,
    );
    writeJson(file, { ...result, text: redact(result.text) });
    const relativePath = path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
    this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      const artifact: GenerationArtifact = {
        ts: now(),
        round,
        label,
        peer: result.peer,
        path: relativePath,
        usage: result.usage,
        cost: result.cost,
        latency_ms: result.latency_ms,
      };
      meta.generation_files = [...(meta.generation_files ?? []), artifact];
      meta.totals = this.totalsFor(meta);
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
    });
    return relativePath;
  }

  saveFinal(sessionId: string, text: string): string {
    const file = path.join(this.sessionDir(sessionId), "final.md");
    fs.writeFileSync(file, redact(text), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  saveReport(sessionId: string, text: string): string {
    const file = path.join(this.sessionDir(sessionId), "session-report.md");
    fs.writeFileSync(file, redact(text), "utf8");
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  savePeerResult(sessionId: string, round: number, result: PeerResult, label = "response"): string {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${result.peer}-${label}.json`,
    );
    writeJson(file, { ...result, text: redact(result.text) });
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  savePeerFailure(sessionId: string, round: number, failure: PeerFailure): string {
    const file = path.join(
      this.sessionDir(sessionId),
      "agent-runs",
      `round-${round}-${failure.peer}-failure.json`,
    );
    writeJson(file, { ...failure, message: redact(failure.message) });
    return path.relative(this.sessionDir(sessionId), file).replace(/\\/g, "/");
  }

  appendRound(
    sessionId: string,
    params: {
      caller_status: ReviewStatus;
      draft_file?: string;
      prompt_file: string;
      peers: PeerResult[];
      rejected: PeerFailure[];
      convergence: ConvergenceResult;
      convergence_scope: ConvergenceScope;
      started_at: string;
    },
  ): ReviewRound {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      const round: ReviewRound = {
        round: meta.rounds.length + 1,
        started_at: params.started_at,
        completed_at: now(),
        caller_status: params.caller_status,
        draft_file: params.draft_file,
        prompt_file: params.prompt_file,
        peers: params.peers,
        rejected: params.rejected,
        convergence: params.convergence,
      };
      meta.rounds.push(round);
      meta.failed_attempts = [
        ...(meta.failed_attempts ?? []),
        ...params.rejected.map((failure) => ({ ...failure, round: round.round })),
      ];
      delete meta.in_flight;
      meta.convergence_scope = params.convergence_scope;
      meta.convergence_health = {
        state: params.convergence.converged ? "converged" : "blocked",
        last_event_at: now(),
        detail: params.convergence.reason,
      };
      meta.updated_at = now();
      meta.totals = this.totalsFor(meta);
      writeJson(this.metaPath(sessionId), meta);
      return round;
    });
  }

  finalize(
    sessionId: string,
    outcome: NonNullable<SessionMeta["outcome"]>,
    reason?: string,
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.outcome = outcome;
      if (reason) meta.outcome_reason = reason;
      delete meta.in_flight;
      meta.convergence_health = {
        state:
          outcome === "converged" ? "converged" : outcome === "max-rounds" ? "blocked" : "stale",
        last_event_at: now(),
        detail: reason ?? outcome,
      };
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  requestCancellation(
    sessionId: string,
    reason = "operator_requested",
    jobId?: string,
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.control = {
        status: "cancel_requested",
        reason,
        job_id: jobId,
        requested_at: now(),
        updated_at: now(),
      };
      meta.convergence_health = {
        state: meta.outcome === "converged" ? "converged" : "blocked",
        last_event_at: now(),
        detail: `Cancellation requested: ${reason}`,
      };
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  markCancelled(sessionId: string, reason = "cancelled"): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.outcome = "aborted";
      meta.outcome_reason = reason;
      delete meta.in_flight;
      meta.control = {
        status: "cancelled",
        reason,
        job_id: meta.control?.job_id,
        requested_at: meta.control?.requested_at,
        updated_at: now(),
      };
      meta.convergence_health = {
        state: "stale",
        last_event_at: now(),
        detail: reason,
      };
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  isCancellationRequested(sessionId: string): boolean {
    const meta = this.read(sessionId);
    return meta.control?.status === "cancel_requested";
  }

  appendFallbackEvent(
    sessionId: string,
    event: NonNullable<SessionMeta["fallback_events"]>[number],
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.fallback_events = [...(meta.fallback_events ?? []), event];
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  recoverInterruptedSessions(activeSessionIds = new Set<string>()): SessionMeta[] {
    const recovered: SessionMeta[] = [];
    for (const session of this.list()) {
      if (session.outcome || activeSessionIds.has(session.session_id) || !session.in_flight)
        continue;
      const updated = this.withSessionLock(session.session_id, () => {
        const current = this.read(session.session_id);
        if (current.outcome || activeSessionIds.has(current.session_id) || !current.in_flight) {
          return current;
        }
        const round = current.in_flight.round;
        delete current.in_flight;
        current.control = {
          status: "recovered_after_restart",
          reason: `Round ${round} was interrupted before completion and can be resumed manually.`,
          updated_at: now(),
        };
        current.convergence_health = {
          state: "stale",
          last_event_at: now(),
          detail: `Recovered interrupted round ${round} after MCP restart. Start a new round to continue from saved session context.`,
        };
        current.updated_at = now();
        writeJson(this.metaPath(current.session_id), current);
        return current;
      });
      recovered.push(updated);
    }
    return recovered;
  }

  metrics(sessionId?: string): RuntimeMetrics {
    const sessions = sessionId ? [this.read(sessionId)] : this.list();
    const peerResults: RuntimeMetrics["peer_results"] = {};
    const peerFailures: RuntimeMetrics["peer_failures"] = {};
    const decisionQuality: RuntimeMetrics["decision_quality"] = {};
    const peerLatencies: number[] = [];
    const generationLatencies: number[] = [];
    let moderationRecoveries = 0;
    let fallbackEvents = 0;

    for (const session of sessions) {
      fallbackEvents += session.fallback_events?.length ?? 0;
      for (const round of session.rounds) {
        for (const peer of round.peers) {
          peerResults[peer.peer] = (peerResults[peer.peer] ?? 0) + 1;
          const quality = peer.decision_quality ?? "failed";
          decisionQuality[quality] = (decisionQuality[quality] ?? 0) + 1;
          if (Number.isFinite(peer.latency_ms)) peerLatencies.push(peer.latency_ms);
          if (peer.parser_warnings.some((warning) => warning.includes("moderation_safe_retry"))) {
            moderationRecoveries += 1;
          }
        }
        for (const failure of round.rejected) {
          peerFailures[failure.failure_class] = (peerFailures[failure.failure_class] ?? 0) + 1;
        }
      }
      for (const generation of session.generation_files ?? []) {
        if (generation.latency_ms != null && Number.isFinite(generation.latency_ms)) {
          generationLatencies.push(generation.latency_ms);
        }
      }
    }

    const average = (values: number[]): number | null =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

    return {
      generated_at: now(),
      scope: sessionId ? "session" : "all",
      session_id: sessionId,
      sessions: {
        total: sessions.length,
        converged: sessions.filter((session) => session.outcome === "converged").length,
        aborted: sessions.filter((session) => session.outcome === "aborted").length,
        max_rounds: sessions.filter((session) => session.outcome === "max-rounds").length,
        unfinished: sessions.filter((session) => !session.outcome).length,
      },
      rounds: sessions.reduce((sum, session) => sum + session.rounds.length, 0),
      peer_results: peerResults,
      peer_failures: peerFailures,
      decision_quality: decisionQuality,
      moderation_recoveries: moderationRecoveries,
      fallback_events: fallbackEvents,
      total_usage: mergeUsage(sessions.map((session) => session.totals.usage)),
      total_cost: mergeCost(sessions.map((session) => session.totals.cost)),
      latency_ms: {
        peer_average: average(peerLatencies),
        generation_average: average(generationLatencies),
      },
    };
  }

  attachEvidence(
    sessionId: string,
    params: { label: string; content: string; content_type?: string; extension?: string },
  ): { path: string; meta: SessionMeta } {
    const extension = safeFilePart(params.extension ?? "txt").replace(/\./g, "") || "txt";
    const label = safeFilePart(params.label);
    const relativePath = `evidence/${timestampFilePart()}-${label}.${extension}`;
    const file = path.join(this.sessionDir(sessionId), relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, redact(params.content), "utf8");

    const meta = this.withSessionLock(sessionId, () => {
      const current = this.read(sessionId);
      current.evidence_files = [
        ...(current.evidence_files ?? []),
        {
          ts: now(),
          label: params.label,
          path: relativePath.replace(/\\/g, "/"),
          content_type: params.content_type,
        },
      ];
      current.updated_at = now();
      writeJson(this.metaPath(sessionId), current);
      return current;
    });

    return { path: relativePath.replace(/\\/g, "/"), meta };
  }

  escalateToOperator(
    sessionId: string,
    params: { reason: string; severity: "info" | "warning" | "critical" },
  ): SessionMeta {
    return this.withSessionLock(sessionId, () => {
      const meta = this.read(sessionId);
      meta.operator_escalations = [
        ...(meta.operator_escalations ?? []),
        { ts: now(), reason: params.reason, severity: params.severity },
      ];
      meta.convergence_health = {
        state: meta.outcome === "converged" ? "converged" : "blocked",
        last_event_at: now(),
        detail: `Operator escalation requested: ${params.reason}`,
      };
      meta.updated_at = now();
      writeJson(this.metaPath(sessionId), meta);
      return meta;
    });
  }

  sweepIdle(
    idleMs: number,
    outcome: "aborted" | "max-rounds" = "aborted",
    reason = "stale",
  ): SessionMeta[] {
    const nowMs = Date.now();
    const swept: SessionMeta[] = [];
    for (const session of this.list()) {
      if (session.outcome) continue;
      const updatedAt = Date.parse(session.updated_at);
      const idleFor = Number.isFinite(updatedAt) ? nowMs - updatedAt : Infinity;
      if (idleFor < idleMs) continue;
      const finalized = this.withSessionLock(session.session_id, () => {
        const current = this.read(session.session_id);
        current.outcome = outcome;
        current.outcome_reason = reason;
        delete current.in_flight;
        current.convergence_health = {
          state: "stale",
          last_event_at: now(),
          detail: reason,
          idle_ms: idleFor,
        };
        current.updated_at = now();
        writeJson(this.metaPath(session.session_id), current);
        return current;
      });
      swept.push(finalized);
    }
    return swept;
  }
}
