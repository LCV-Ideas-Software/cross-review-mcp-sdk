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

process.env.CROSS_REVIEW_V2_STUB = "1";
process.env.CROSS_REVIEW_V2_DATA_DIR =
  process.env.CROSS_REVIEW_V2_DATA_DIR ||
  path.join(os.tmpdir(), `cross-review-v2-smoke-${Date.now()}`);
process.env.CROSS_REVIEW_OPENAI_FALLBACK_MODELS ??= "stub-codex-fallback";
for (const provider of ["OPENAI", "ANTHROPIC", "GEMINI", "DEEPSEEK"]) {
  process.env[`CROSS_REVIEW_${provider}_INPUT_USD_PER_MILLION`] ??= "1000";
  process.env[`CROSS_REVIEW_${provider}_OUTPUT_USD_PER_MILLION`] ??= "1000";
}

const config = loadConfig();
const events: string[] = [];
const holder: { orchestrator?: CrossReviewOrchestrator } = {};
const orchestrator = new CrossReviewOrchestrator(config, (event) => {
  events.push(event.type);
  holder.orchestrator?.store.appendEvent(event);
});
holder.orchestrator = orchestrator;

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
    decision_quality: "clean",
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
assert.ok((result.session.generation_files?.length ?? 0) >= 1);
assert.equal(result.session.in_flight, undefined);
assert.equal(result.session.convergence_health?.state, "converged");
assert.ok((result.session.totals.usage.total_tokens ?? 0) > 0);
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

process.env.CROSS_REVIEW_V2_STUB_REPORTED_MODEL = "stub-downgraded";
const mismatch = await orchestrator.askPeers({
  task: "Verify silent model downgrade handling.",
  draft: "This draft is intentionally simple.",
  caller: "operator",
  peers: ["codex"],
});
delete process.env.CROSS_REVIEW_V2_STUB_REPORTED_MODEL;
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
assert.equal(formatRecovered.round.peers[0]?.decision_quality, "recovered");

const formatRecoveryFailed = await orchestrator.askPeers({
  task: "Verify automatic parser format recovery failure handling.",
  draft: "FORCE_BAD_FORMAT_UNRECOVERABLE",
  caller: "operator",
  peers: ["codex"],
});
assert.equal(formatRecoveryFailed.converged, false);
assert.equal(
  formatRecoveryFailed.round.rejected.at(-1)?.failure_class,
  "unparseable_after_recovery",
);
assert.equal(formatRecoveryFailed.round.peers[0]?.decision_quality, "needs_operator_review");

const moderationRecovered = await orchestrator.askPeers({
  task: "Verify compact moderation-safe retry handling.",
  draft: "FORCE_MODERATION_FAIL",
  caller: "operator",
  peers: ["codex"],
});
assert.equal(moderationRecovered.converged, true);
assert.equal(
  moderationRecovered.round.peers[0]?.parser_warnings.includes("moderation_safe_retry_succeeded"),
  true,
);
assert.equal(moderationRecovered.round.peers[0]?.decision_quality, "recovered");

const moderationRetryFailed = await orchestrator.askPeers({
  task: "Verify compact moderation-safe retry failure handling.",
  draft: "FORCE_MODERATION_FAIL_UNRECOVERABLE",
  caller: "operator",
  peers: ["codex"],
});
assert.equal(moderationRetryFailed.converged, false);
assert.equal(
  moderationRetryFailed.round.rejected.at(-1)?.failure_class,
  "prompt_flagged_by_moderation",
);
assert.equal(moderationRetryFailed.round.rejected.at(-1)?.recovery_hint, "reformulate_and_retry");

const fallbackRecovered = await orchestrator.askPeers({
  task: "Verify model fallback handling.",
  draft: "FORCE_NETWORK_FAIL",
  caller: "operator",
  peers: ["codex"],
});
assert.equal(fallbackRecovered.converged, true);
assert.equal(fallbackRecovered.round.peers[0]?.fallback?.to_model, "stub-codex-fallback");
assert.equal(
  fallbackRecovered.round.peers[0]?.parser_warnings.some((warning) =>
    warning.startsWith("fallback_model_used:"),
  ),
  true,
);

const budgetExceeded = await orchestrator.runUntilUnanimous({
  task: "Verify configured budget limit stops non-converged sessions.",
  initial_draft: "FORCE_NOT_READY",
  lead_peer: "codex",
  peers: ["claude"],
  max_rounds: 3,
  max_cost_usd: 0.000001,
});
assert.equal(budgetExceeded.converged, false);
assert.equal(budgetExceeded.session.outcome, "max-rounds");
assert.equal(budgetExceeded.session.outcome_reason, "budget_exceeded");
assert.equal(budgetExceeded.rounds, 1);

const recoverySession = orchestrator.store.init("interrupted smoke session", "operator", probes);
orchestrator.store.markInFlight(recoverySession.session_id, {
  round: 1,
  peers: ["codex"],
  started_at: new Date().toISOString(),
  scope: {
    caller: "operator",
    caller_status: "READY",
    expected_peers: ["codex"],
    reviewer_peers: ["codex"],
  },
});
const recoveredInterrupted = orchestrator.store.recoverInterruptedSessions();
assert.equal(
  recoveredInterrupted.some((session) => session.session_id === recoverySession.session_id),
  true,
);
assert.equal(
  orchestrator.store.read(recoverySession.session_id).control?.status,
  "recovered_after_restart",
);

const abortController = new AbortController();
const cancellableRound = orchestrator.askPeers({
  task: "Verify cooperative cancellation handling.",
  draft: "FORCE_CANCEL_SLOW",
  caller: "operator",
  peers: ["codex"],
  signal: abortController.signal,
});
setTimeout(() => abortController.abort("smoke_cancel"), 50);
const cancelledRound = await cancellableRound;
assert.equal(cancelledRound.converged, false);
assert.equal(cancelledRound.round.rejected.at(-1)?.failure_class, "cancelled");

process.env.CROSS_REVIEW_V2_PREFLIGHT_MAX_ROUND_COST_USD = "0.000001";
process.env.CROSS_REVIEW_V2_DATA_DIR = path.join(
  os.tmpdir(),
  `cross-review-v2-preflight-smoke-${Date.now()}`,
);
const preflightOrchestrator = new CrossReviewOrchestrator(loadConfig());
const preflightBlocked = await preflightOrchestrator.askPeers({
  task: "Verify budget preflight.",
  draft: "This draft should be blocked before a peer call.",
  caller: "operator",
  peers: ["codex"],
});
assert.equal(preflightBlocked.converged, false);
assert.equal(preflightBlocked.round.rejected.at(-1)?.failure_class, "budget_preflight");
assert.equal(preflightBlocked.session.outcome_reason, "budget_preflight");

const eventful = orchestrator.store.readEvents(formatRecovered.session.session_id);
assert.equal(
  eventful.some((event) => event.type === "round.completed"),
  true,
);
assert.deepEqual(
  eventful.map((event) => event.seq),
  eventful.map((_, index) => index + 1),
);

const metrics = orchestrator.store.metrics();
assert.equal(metrics.fallback_events, 1);
assert.equal((metrics.peer_failures.cancelled ?? 0) >= 1, true);
assert.equal(Object.prototype.hasOwnProperty.call(metrics.decision_quality, "undefined"), false);

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
