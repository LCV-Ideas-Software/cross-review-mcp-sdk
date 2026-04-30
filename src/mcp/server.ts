#!/usr/bin/env node
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RELEASE_DATE, VERSION, loadConfig } from "../core/config.js";
import { CrossReviewOrchestrator } from "../core/orchestrator.js";
import { PEERS } from "../core/types.js";
import type { PeerId, RuntimeCapabilities, RuntimeEvent } from "../core/types.js";
import { sessionReportMarkdown } from "../core/reports.js";
import { EventLog } from "../observability/logger.js";
import { safeErrorMessage } from "../security/redact.js";

const PeerSchema = z.enum(PEERS);
const ResponseFormatSchema = z.enum(["json", "markdown"]).default("json");

function textResult(value: unknown, responseFormat = "json") {
  const text =
    responseFormat === "markdown" && typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

type JobKind = "ask_peers" | "run_until_unanimous";
type JobStatus = {
  job_id: string;
  kind: JobKind;
  session_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at?: string;
  error?: string;
  result_summary?: Record<string, unknown>;
};

function createRuntime() {
  const config = loadConfig();
  const eventLog = new EventLog(config);
  const holder: { orchestrator?: CrossReviewOrchestrator } = {};
  const emit = (event: RuntimeEvent) => {
    eventLog.emit(event);
    holder.orchestrator?.store.appendEvent(event);
  };
  const orchestrator = new CrossReviewOrchestrator(config, emit);
  holder.orchestrator = orchestrator;
  return {
    config,
    eventLog,
    orchestrator,
    jobs: new Map<string, JobStatus>(),
    controllers: new Map<string, AbortController>(),
  };
}

type Runtime = ReturnType<typeof createRuntime>;

function now(): string {
  return new Date().toISOString();
}

function summarizeJobResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && "session" in result) {
    const session = (result as { session?: { session_id?: string; outcome?: string } }).session;
    return {
      session_id: session?.session_id,
      outcome: session?.outcome,
      converged: "converged" in result ? (result as { converged?: boolean }).converged : undefined,
      rounds: "rounds" in result ? (result as { rounds?: number }).rounds : undefined,
    };
  }
  return {};
}

function startJob(
  runtime: Runtime,
  kind: JobKind,
  sessionId: string,
  run: (signal: AbortSignal) => Promise<unknown>,
): JobStatus {
  const controller = new AbortController();
  const job: JobStatus = {
    job_id: crypto.randomUUID(),
    kind,
    session_id: sessionId,
    status: "running",
    started_at: now(),
  };
  runtime.jobs.set(job.job_id, job);
  runtime.controllers.set(job.job_id, controller);
  void run(controller.signal)
    .then((result) => {
      job.status = controller.signal.aborted ? "cancelled" : "completed";
      job.completed_at = now();
      job.result_summary = summarizeJobResult(result);
      runtime.controllers.delete(job.job_id);
      if (controller.signal.aborted) {
        try {
          runtime.orchestrator.store.markCancelled(sessionId, "session_cancelled");
        } catch {
          // The job status remains visible even if a session write fails.
        }
      }
    })
    .catch((error) => {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.completed_at = now();
      job.error = safeErrorMessage(error);
      runtime.controllers.delete(job.job_id);
      try {
        if (controller.signal.aborted) {
          runtime.orchestrator.store.markCancelled(sessionId, "session_cancelled");
        } else {
          runtime.orchestrator.store.escalateToOperator(sessionId, {
            reason: `Background job failed: ${job.error}`,
            severity: "critical",
          });
        }
      } catch {
        // Job state remains available even if the session cannot be updated.
      }
    });
  return job;
}

function runtimeCapabilities(): RuntimeCapabilities {
  return {
    stable_release: true,
    api_only: true,
    cli_execution: false,
    durable_sessions: true,
    async_jobs: true,
    cancellation: true,
    restart_recovery: true,
    event_streaming: true,
    token_streaming: false,
    budget_preflight: true,
    model_fallback: true,
    metrics: true,
  };
}

const TOOL_NAMES = [
  "server_info",
  "runtime_capabilities",
  "probe_peers",
  "session_init",
  "session_list",
  "session_read",
  "ask_peers",
  "session_start_round",
  "run_until_unanimous",
  "session_start_unanimous",
  "session_cancel_job",
  "session_recover_interrupted",
  "session_poll",
  "session_events",
  "session_metrics",
  "session_report",
  "session_check_convergence",
  "session_attach_evidence",
  "escalate_to_operator",
  "session_sweep",
  "session_finalize",
] as const;

export async function main(): Promise<void> {
  const runtime = createRuntime();
  const server = new McpServer({
    name: "cross-review-v2",
    version: VERSION,
  });

  server.registerTool(
    "server_info",
    {
      title: "Server Info",
      description:
        "Return runtime information for the API-only Cross Review MCP server, including version, data directory and active security mode.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) =>
      textResult(
        {
          name: "cross-review-v2",
          publisher: "LCV Ideas & Software",
          version: VERSION,
          release_date: RELEASE_DATE,
          sponsors_url: "https://cross-review-v2.lcv.app.br",
          transport: "stdio",
          api_only: true,
          cli_execution: false,
          stable_release: true,
          capabilities: runtimeCapabilities(),
          tools: TOOL_NAMES,
          data_dir: runtime.config.data_dir,
          log_file: runtime.eventLog.path(),
          stub: runtime.config.stub,
          retry_timeout_ms: runtime.config.retry.timeout_ms,
          budget: runtime.config.budget,
          prompt: runtime.config.prompt,
          streaming: runtime.config.streaming,
          codeql_policy: "Default Setup on GitHub; no advanced workflow committed.",
          secrets_policy: "API keys are read from Windows environment variables only.",
        },
        response_format,
      ),
  );

  server.registerTool(
    "runtime_capabilities",
    {
      title: "Runtime Capabilities",
      description:
        "Return the stable cross-review-v2 runtime capability contract and active tool list.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) =>
      textResult(
        {
          name: "cross-review-v2",
          version: VERSION,
          release_date: RELEASE_DATE,
          capabilities: runtimeCapabilities(),
          tools: TOOL_NAMES,
        },
        response_format,
      ),
  );

  server.registerTool(
    "probe_peers",
    {
      title: "Probe Peers",
      description:
        "Query official provider APIs to discover available models for the current API keys, select the highest-capability documented model, and verify provider reachability.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ response_format }) =>
      textResult(await runtime.orchestrator.probeAll(), response_format),
  );

  server.registerTool(
    "session_init",
    {
      title: "Initialize Session",
      description:
        "Create a durable cross-review session after probing provider availability and model selection. This does not call reviewer models yet.",
      inputSchema: z
        .object({
          task: z.string().min(1).describe("Original task or artifact being reviewed."),
          caller: z.union([PeerSchema, z.literal("operator")]).default("operator"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ task, caller, response_format }) =>
      textResult(await runtime.orchestrator.initSession(task, caller), response_format),
  );

  server.registerTool(
    "session_list",
    {
      title: "List Sessions",
      description: "List durable sessions saved under the local data directory.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => textResult(runtime.orchestrator.store.list(), response_format),
  );

  server.registerTool(
    "session_read",
    {
      title: "Read Session",
      description: "Read a durable session meta.json by session_id.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) =>
      textResult(runtime.orchestrator.store.read(session_id), response_format),
  );

  server.registerTool(
    "ask_peers",
    {
      title: "Ask Peers",
      description:
        "Run a real API review round against selected peers. Runtime default uses real provider APIs; stubs run only when CROSS_REVIEW_V2_STUB=1.",
      inputSchema: z
        .object({
          session_id: z.string().uuid().optional(),
          task: z.string().min(1),
          draft: z.string().min(1),
          caller: z.union([PeerSchema, z.literal("operator")]).default("operator"),
          caller_status: z.enum(["READY", "NOT_READY", "NEEDS_EVIDENCE"]).default("READY"),
          peers: z
            .array(PeerSchema)
            .min(1)
            .max(4)
            .default([...PEERS] as PeerId[]),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ response_format, ...input }) =>
      textResult(await runtime.orchestrator.askPeers(input), response_format),
  );

  server.registerTool(
    "session_start_round",
    {
      title: "Start Review Round",
      description:
        "Start a real peer-review round in the background and return immediately with a session_id/job_id for polling.",
      inputSchema: z
        .object({
          session_id: z.string().uuid().optional(),
          task: z.string().min(1),
          draft: z.string().min(1),
          caller: z.union([PeerSchema, z.literal("operator")]).default("operator"),
          caller_status: z.enum(["READY", "NOT_READY", "NEEDS_EVIDENCE"]).default("READY"),
          peers: z
            .array(PeerSchema)
            .min(1)
            .max(4)
            .default([...PEERS] as PeerId[]),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ response_format, ...input }) => {
      const session = input.session_id
        ? runtime.orchestrator.store.read(input.session_id)
        : await runtime.orchestrator.initSession(input.task, input.caller);
      const job = startJob(runtime, "ask_peers", session.session_id, (signal) =>
        runtime.orchestrator.askPeers({ ...input, session_id: session.session_id, signal }),
      );
      return textResult(
        {
          session_id: session.session_id,
          job,
          poll_tool: "session_poll",
          events_tool: "session_events",
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "run_until_unanimous",
    {
      title: "Run Until Unanimous",
      description:
        "Generate or revise a draft and continue real API peer-review rounds until unanimous READY or the configured max_rounds is reached.",
      inputSchema: z
        .object({
          task: z.string().min(1),
          initial_draft: z.string().optional(),
          lead_peer: PeerSchema.default("codex"),
          peers: z
            .array(PeerSchema)
            .min(1)
            .max(4)
            .default([...PEERS] as PeerId[]),
          max_rounds: z.number().int().min(1).max(1000).default(8),
          until_stopped: z.boolean().default(false),
          max_cost_usd: z.number().positive().optional(),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ response_format, ...input }) =>
      textResult(await runtime.orchestrator.runUntilUnanimous(input), response_format),
  );

  server.registerTool(
    "session_start_unanimous",
    {
      title: "Start Until Unanimous",
      description:
        "Start real API generation/revision rounds in the background until unanimity, max_rounds or budget limit.",
      inputSchema: z
        .object({
          session_id: z.string().uuid().optional(),
          task: z.string().min(1),
          initial_draft: z.string().optional(),
          lead_peer: PeerSchema.default("codex"),
          peers: z
            .array(PeerSchema)
            .min(1)
            .max(4)
            .default([...PEERS] as PeerId[]),
          max_rounds: z.number().int().min(1).max(1000).default(8),
          until_stopped: z.boolean().default(false),
          max_cost_usd: z.number().positive().optional(),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ response_format, ...input }) => {
      const session = input.session_id
        ? runtime.orchestrator.store.read(input.session_id)
        : await runtime.orchestrator.initSession(input.task, input.lead_peer);
      const job = startJob(runtime, "run_until_unanimous", session.session_id, (signal) =>
        runtime.orchestrator.runUntilUnanimous({
          ...input,
          session_id: session.session_id,
          signal,
        }),
      );
      return textResult(
        {
          session_id: session.session_id,
          job,
          poll_tool: "session_poll",
          events_tool: "session_events",
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "session_cancel_job",
    {
      title: "Cancel Session Job",
      description:
        "Request cancellation for running background jobs in a durable session. Provider calls receive AbortSignal where the provider client supports it.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          job_id: z.string().uuid().optional(),
          reason: z.string().min(1).max(300).default("operator_requested"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, job_id, reason, response_format }) => {
      const jobs = [...runtime.jobs.values()].filter(
        (job) =>
          job.session_id === session_id &&
          job.status === "running" &&
          (!job_id || job.job_id === job_id),
      );
      const meta = runtime.orchestrator.store.requestCancellation(session_id, reason, job_id);
      for (const job of jobs) {
        runtime.controllers.get(job.job_id)?.abort(reason);
      }
      if (!jobs.length) {
        runtime.orchestrator.store.markCancelled(session_id, reason);
      }
      return textResult(
        {
          session_id,
          requested: true,
          matched_jobs: jobs,
          control: meta.control,
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "session_recover_interrupted",
    {
      title: "Recover Interrupted Sessions",
      description:
        "Mark unfinished sessions with stale in-flight rounds as recovered after a MCP host restart so they can be resumed explicitly.",
      inputSchema: z.object({ response_format: ResponseFormatSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
      const active = new Set(
        [...runtime.jobs.values()]
          .filter((job) => job.status === "running")
          .map((job) => job.session_id),
      );
      return textResult(
        {
          recovered: runtime.orchestrator.store.recoverInterruptedSessions(active),
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "session_poll",
    {
      title: "Poll Session",
      description:
        "Return durable session state and background job status without waiting for provider calls to finish.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) => {
      const session = runtime.orchestrator.store.read(session_id);
      const jobs = [...runtime.jobs.values()].filter((job) => job.session_id === session_id);
      return textResult(
        {
          session_id,
          outcome: session.outcome,
          health: session.convergence_health,
          in_flight: session.in_flight,
          rounds: session.rounds.length,
          latest_round: session.rounds.at(-1) ?? null,
          jobs,
          control: session.control,
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "session_metrics",
    {
      title: "Session Metrics",
      description:
        "Return aggregate observability metrics across all sessions, or only one session when session_id is provided.",
      inputSchema: z
        .object({
          session_id: z.string().uuid().optional(),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) =>
      textResult(runtime.orchestrator.store.metrics(session_id), response_format),
  );

  server.registerTool(
    "session_events",
    {
      title: "Read Session Events",
      description:
        "Read durable session events from events.ndjson. Use since_seq to incrementally poll long-running sessions.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          since_seq: z.number().int().min(0).default(0),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, since_seq, response_format }) =>
      textResult(
        {
          session_id,
          events: runtime.orchestrator.store.readEvents(session_id, since_seq),
        },
        response_format,
      ),
  );

  server.registerTool(
    "session_report",
    {
      title: "Session Report",
      description:
        "Generate and save a Markdown report with convergence, peer decisions, failures, costs and latest events.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) => {
      const session = runtime.orchestrator.store.read(session_id);
      const markdown = sessionReportMarkdown(
        session,
        runtime.orchestrator.store.readEvents(session_id),
      );
      const path = runtime.orchestrator.store.saveReport(session_id, markdown);
      return response_format === "markdown"
        ? textResult(markdown, "markdown")
        : textResult({ session_id, path, markdown }, response_format);
    },
  );

  server.registerTool(
    "session_check_convergence",
    {
      title: "Check Convergence",
      description:
        "Return the latest durable convergence state, health and scope for a saved session without calling providers.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, response_format }) => {
      const session = runtime.orchestrator.store.read(session_id);
      const latestRound = session.rounds.at(-1);
      return textResult(
        {
          session_id: session.session_id,
          outcome: session.outcome,
          outcome_reason: session.outcome_reason,
          convergence: latestRound?.convergence ?? null,
          convergence_health: session.convergence_health,
          convergence_scope: session.convergence_scope,
          in_flight: session.in_flight,
          failed_attempts: session.failed_attempts ?? [],
        },
        response_format,
      );
    },
  );

  server.registerTool(
    "session_attach_evidence",
    {
      title: "Attach Evidence",
      description:
        "Persist a text evidence artifact under a durable session evidence directory and register it in session metadata.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          label: z.string().min(1).max(120),
          content: z.string().min(1).max(2_000_000),
          content_type: z.string().min(1).max(120).default("text/plain"),
          extension: z.string().min(1).max(16).default("txt"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, label, content, content_type, extension, response_format }) =>
      textResult(
        runtime.orchestrator.store.attachEvidence(session_id, {
          label,
          content,
          content_type,
          extension,
        }),
        response_format,
      ),
  );

  server.registerTool(
    "escalate_to_operator",
    {
      title: "Escalate To Operator",
      description:
        "Record a durable operator escalation for sessions that require human judgment or external intervention.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          reason: z.string().min(1).max(1000),
          severity: z.enum(["info", "warning", "critical"]).default("warning"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id, reason, severity, response_format }) =>
      textResult(
        runtime.orchestrator.store.escalateToOperator(session_id, { reason, severity }),
        response_format,
      ),
  );

  server.registerTool(
    "session_sweep",
    {
      title: "Sweep Idle Sessions",
      description:
        "Finalize unfinished sessions whose metadata has been idle for the requested number of minutes.",
      inputSchema: z
        .object({
          idle_minutes: z.number().min(0).max(100_000).default(60),
          outcome: z.enum(["aborted", "max-rounds"]).default("aborted"),
          reason: z.string().min(1).max(200).default("stale"),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ idle_minutes, outcome, reason, response_format }) =>
      textResult(
        runtime.orchestrator.store.sweepIdle(idle_minutes * 60_000, outcome, reason),
        response_format,
      ),
  );

  server.registerTool(
    "session_finalize",
    {
      title: "Finalize Session",
      description:
        "Mark a durable session as converged, aborted or max-rounds with an optional reason.",
      inputSchema: z
        .object({
          session_id: z.string().uuid(),
          outcome: z.enum(["converged", "aborted", "max-rounds"]),
          reason: z.string().max(200).optional(),
          response_format: ResponseFormatSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, outcome, reason, response_format }) =>
      textResult(runtime.orchestrator.store.finalize(session_id, outcome, reason), response_format),
  );

  await server.connect(new StdioServerTransport());
  console.error("cross-review-v2 running on stdio");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
