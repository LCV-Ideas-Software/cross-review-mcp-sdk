import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkConvergence } from "../src/core/convergence.js";
import { loadConfig } from "../src/core/config.js";
import { CrossReviewOrchestrator } from "../src/core/orchestrator.js";
import { parsePeerStatus } from "../src/core/status.js";
import { PEERS } from "../src/core/types.js";
import type { PeerResult } from "../src/core/types.js";

process.env.CROSS_REVIEW_SDK_STUB = "1";
process.env.CROSS_REVIEW_SDK_DATA_DIR =
  process.env.CROSS_REVIEW_SDK_DATA_DIR ||
  path.join(os.tmpdir(), `cross-review-mcp-sdk-smoke-${Date.now()}`);

const config = loadConfig();
const events: string[] = [];
const orchestrator = new CrossReviewOrchestrator(config, (event) => events.push(event.type));

const overlongReady = parsePeerStatus(
  JSON.stringify({
    status: "READY",
    summary: "A".repeat(1_500),
    confidence: "verified",
    evidence_sources: [],
    caller_requests: [],
    follow_ups: [],
  }),
);
assert.equal(overlongReady.status, "READY");
assert.equal(overlongReady.structured?.summary?.length, 800);
assert.equal(overlongReady.parser_warnings.includes("summary_truncated_to_800"), true);

const fencedReady = parsePeerStatus(
  [
    "Review complete.",
    "```json",
    JSON.stringify({
      status: "READY",
      summary: "Approved inside a fenced JSON block.",
      confidence: "verified",
      evidence_sources: [],
      caller_requests: [],
      follow_ups: [],
    }),
    "```",
  ].join("\n"),
);
assert.equal(fencedReady.status, "READY");
assert.equal(fencedReady.parser_warnings.includes("status_json_extracted_from_fence"), true);

const invalidJsonRecovered = parsePeerStatus('{ "status": "READY", "summary": "ok", ');
assert.equal(invalidJsonRecovered.status, "READY");
assert.equal(
  invalidJsonRecovered.parser_warnings.some((warning) =>
    warning.startsWith("status_recovered_from_invalid_json"),
  ),
  true,
);

const fakeReady = (peer: PeerResult["peer"]): PeerResult =>
  ({
    peer,
    provider: "stub",
    model: "stub",
    status: "READY",
    structured: { status: "READY" },
    text: "{}",
    raw: {},
    latency_ms: 0,
    attempts: 1,
    parser_warnings: [],
  }) satisfies PeerResult;
assert.equal(
  checkConvergence(["codex", "claude"], "READY", [fakeReady("codex")], []).converged,
  false,
);
assert.equal(
  checkConvergence(["codex", "claude"], "READY", [fakeReady("codex"), fakeReady("claude")], [])
    .converged,
  true,
);

const probes = await orchestrator.probeAll();
assert.equal(probes.length, PEERS.length);
assert.equal(
  probes.every((probe) => probe.available),
  true,
);

const result = await orchestrator.runUntilUnanimous({
  task: "Escreva um paragrafo curto sobre validacao de software.",
  lead_peer: "codex",
  max_rounds: 2,
});

assert.equal(result.converged, true);
assert.ok(result.session.session_id);
assert.equal(result.session.rounds.length, 1);
assert.equal(result.session.in_flight, undefined);
assert.equal(result.session.convergence_health?.state, "converged");
assert.ok(events.includes("round.completed"));

const finalPath = path.join(config.data_dir, "sessions", result.session.session_id, "final.md");
assert.equal(fs.existsSync(finalPath), true);

const evidence = orchestrator.store.attachEvidence(result.session.session_id, {
  label: "smoke evidence",
  content: "smoke evidence body",
  content_type: "text/markdown",
  extension: "md",
});
assert.equal(
  fs.existsSync(path.join(config.data_dir, "sessions", result.session.session_id, evidence.path)),
  true,
);

const escalated = orchestrator.store.escalateToOperator(result.session.session_id, {
  reason: "smoke operator escalation",
  severity: "info",
});
assert.equal(escalated.operator_escalations?.at(-1)?.severity, "info");

const stale = orchestrator.store.init("unfinished smoke session", "operator", probes);
const swept = orchestrator.store.sweepIdle(0, "aborted", "smoke_stale");
assert.equal(
  swept.some((session) => session.session_id === stale.session_id),
  true,
);
assert.equal(orchestrator.store.read(stale.session_id).outcome, "aborted");

process.env.CROSS_REVIEW_SDK_STUB_REPORTED_MODEL = "stub-downgraded";
const mismatch = await orchestrator.askPeers({
  task: "Verify silent model downgrade handling.",
  draft: "This draft is intentionally simple.",
  caller: "operator",
  peers: ["codex"],
});
delete process.env.CROSS_REVIEW_SDK_STUB_REPORTED_MODEL;
assert.equal(mismatch.converged, false);
assert.equal(mismatch.round.rejected.at(-1)?.failure_class, "silent_model_downgrade");
assert.equal(mismatch.session.failed_attempts?.at(-1)?.failure_class, "silent_model_downgrade");

const formatRecovered = await orchestrator.askPeers({
  task: "Verify automatic parser format recovery.",
  draft: "FORCE_BAD_FORMAT",
  caller: "operator",
  peers: ["codex"],
});
assert.equal(formatRecovered.converged, true);
assert.equal(formatRecovered.round.peers[0]?.status, "READY");
assert.equal(
  formatRecovered.round.peers[0]?.parser_warnings.includes("format_recovery_retry_succeeded"),
  true,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      session_id: result.session.session_id,
      data_dir: config.data_dir,
      events: events.length,
    },
    null,
    2,
  ),
);
