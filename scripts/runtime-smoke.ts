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

try {
  await client.connect(transport);
  const result = await client.callTool(
    { name: "server_info", arguments: { response_format: "json" } },
    undefined,
    { timeout: MCP_REQUEST_TIMEOUT_MS, maxTotalTimeout: MCP_REQUEST_TIMEOUT_MS },
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}
