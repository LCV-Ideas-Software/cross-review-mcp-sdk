import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_REQUEST_TIMEOUT_MS } from "../src/core/timeouts.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/mcp/server.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    CROSS_REVIEW_SDK_STUB: process.env.CROSS_REVIEW_SDK_STUB ?? "1",
  },
});

const client = new Client({ name: "cross-review-mcp-sdk-runtime-smoke", version: "0.0.0" });

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: MCP_REQUEST_TIMEOUT_MS,
    maxTotalTimeout: MCP_REQUEST_TIMEOUT_MS,
  });
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content[0]?.type === "text" ? (content[0].text ?? "{}") : "{}";
  return JSON.parse(text);
}

async function pollUntilDone(sessionId: string): Promise<unknown> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = (await callTool("session_poll", {
      session_id: sessionId,
      response_format: "json",
    })) as { jobs?: Array<{ status: string }> };
    if (state.jobs?.some((job) => job.status === "completed" || job.status === "failed")) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out polling runtime-smoke session ${sessionId}`);
}

try {
  await client.connect(transport);
  const serverInfo = await callTool("server_info", { response_format: "json" });
  const roundStart = (await callTool("session_start_round", {
    task: "Runtime smoke: verify async review round.",
    draft: "Runtime smoke draft.",
    peers: ["codex"],
    response_format: "json",
  })) as { session_id: string };
  const roundState = await pollUntilDone(roundStart.session_id);
  const events = await callTool("session_events", {
    session_id: roundStart.session_id,
    response_format: "json",
  });
  const report = await callTool("session_report", {
    session_id: roundStart.session_id,
    response_format: "json",
  });
  const unanimousStart = (await callTool("session_start_unanimous", {
    task: "Runtime smoke: verify async unanimity flow.",
    lead_peer: "codex",
    peers: ["claude"],
    max_rounds: 2,
    response_format: "json",
  })) as { session_id: string };
  const unanimousState = await pollUntilDone(unanimousStart.session_id);
  console.log(
    JSON.stringify(
      {
        ok: true,
        serverInfo,
        round_session_id: roundStart.session_id,
        roundState,
        events,
        report,
        unanimous_session_id: unanimousStart.session_id,
        unanimousState,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
