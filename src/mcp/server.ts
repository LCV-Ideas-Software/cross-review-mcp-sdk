#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RELEASE_DATE, VERSION, loadConfig } from "../core/config.js";
import { CrossReviewOrchestrator } from "../core/orchestrator.js";
import { PEERS } from "../core/types.js";
import type { PeerId } from "../core/types.js";
import { EventLog } from "../observability/logger.js";

const PeerSchema = z.enum(PEERS);
const ResponseFormatSchema = z.enum(["json", "markdown"]).default("json");

function textResult(value: unknown, responseFormat = "json") {
  const text =
    responseFormat === "markdown" && typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function createRuntime() {
  const config = loadConfig();
  const eventLog = new EventLog(config);
  const orchestrator = new CrossReviewOrchestrator(config, (event) => eventLog.emit(event));
  return { config, eventLog, orchestrator };
}

export async function main(): Promise<void> {
  const runtime = createRuntime();
  const server = new McpServer({
    name: "cross-review-mcp-sdk",
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
          name: "cross-review-mcp-sdk",
          publisher: "LCV Ideas & Software",
          version: VERSION,
          release_date: RELEASE_DATE,
          sponsors_url: "https://cross-review-mcp-sdk.lcv.app.br",
          transport: "stdio",
          sdk_only: true,
          cli_execution: false,
          data_dir: runtime.config.data_dir,
          log_file: runtime.eventLog.path(),
          stub: runtime.config.stub,
          codeql_policy: "Default Setup on GitHub; no advanced workflow committed.",
          secrets_policy: "API keys are read from Windows environment variables only.",
        },
        response_format,
      ),
  );

  server.registerTool(
    "probe_peers",
    {
      title: "Probe Peers",
      description:
        "Query official provider APIs/SDKs to discover available models for the current API keys, select the highest-capability documented model, and verify provider reachability.",
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
        "Run a real API/SDK review round against selected peers. Runtime default uses real provider APIs; stubs run only when CROSS_REVIEW_SDK_STUB=1.",
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
          max_rounds: z.number().int().min(1).max(100).default(8),
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
  console.error("cross-review-mcp-sdk running on stdio");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
