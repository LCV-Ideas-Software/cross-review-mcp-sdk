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
import { selectFromCandidates } from "../src/peers/model-selection.js";
import { StubAdapter } from "../src/peers/stub.js";
import { redact } from "../src/security/redact.js";

process.env.CROSS_REVIEW_V2_STUB = "1";
process.env.CROSS_REVIEW_V2_DATA_DIR =
  process.env.CROSS_REVIEW_V2_DATA_DIR ||
  path.join(os.tmpdir(), `cross-review-v2-smoke-${Date.now()}`);
process.env.CROSS_REVIEW_OPENAI_FALLBACK_MODELS ??= "stub-codex-fallback";
for (const provider of ["OPENAI", "ANTHROPIC", "GEMINI", "DEEPSEEK"]) {
  process.env[`CROSS_REVIEW_${provider}_INPUT_USD_PER_MILLION`] ??= "1000";
  process.env[`CROSS_REVIEW_${provider}_OUTPUT_USD_PER_MILLION`] ??= "1000";
}

const previousMaxOutputTokens = process.env.CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS;
const previousMaxReviewFocusChars = process.env.CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS;
const previousStreamTokens = process.env.CROSS_REVIEW_V2_STREAM_TOKENS;
const previousStreamText = process.env.CROSS_REVIEW_V2_STREAM_TEXT;
process.env.CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS = "32000";
assert.equal(loadConfig().max_output_tokens, 32_000);
process.env.CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS = "not-a-number";
assert.equal(loadConfig().max_output_tokens, 20_000);
process.env.CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS = "1234";
assert.equal(loadConfig().prompt.max_review_focus_chars, 1_234);
process.env.CROSS_REVIEW_V2_STREAM_TOKENS = "0";
assert.equal(loadConfig().streaming.tokens, false);
process.env.CROSS_REVIEW_V2_STREAM_TOKENS = "1";
assert.equal(loadConfig().streaming.tokens, true);
process.env.CROSS_REVIEW_V2_STREAM_TEXT = "0";
assert.equal(loadConfig().streaming.include_text, false);
process.env.CROSS_REVIEW_V2_STREAM_TEXT = "1";
assert.equal(loadConfig().streaming.include_text, true);
if (previousMaxOutputTokens == null) {
  delete process.env.CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS;
} else {
  process.env.CROSS_REVIEW_V2_MAX_OUTPUT_TOKENS = previousMaxOutputTokens;
}
if (previousMaxReviewFocusChars == null) {
  delete process.env.CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS;
} else {
  process.env.CROSS_REVIEW_V2_MAX_REVIEW_FOCUS_CHARS = previousMaxReviewFocusChars;
}
if (previousStreamTokens == null) {
  delete process.env.CROSS_REVIEW_V2_STREAM_TOKENS;
} else {
  process.env.CROSS_REVIEW_V2_STREAM_TOKENS = previousStreamTokens;
}
if (previousStreamText == null) {
  delete process.env.CROSS_REVIEW_V2_STREAM_TEXT;
} else {
  process.env.CROSS_REVIEW_V2_STREAM_TEXT = previousStreamText;
}

const config = loadConfig();
assert.equal(
  config.max_output_tokens,
  previousMaxOutputTokens && Number.parseInt(previousMaxOutputTokens, 10) > 0
    ? Number.parseInt(previousMaxOutputTokens, 10)
    : 20_000,
);
const events: string[] = [];
const holder: { orchestrator?: CrossReviewOrchestrator } = {};
const orchestrator = new CrossReviewOrchestrator(config, (event) => {
  events.push(event.type);
  holder.orchestrator?.store.appendEvent(event);
});
holder.orchestrator = orchestrator;

const adapterExpectations: Array<{ file: string; field: string }> = [
  { file: "src/peers/openai.ts", field: "max_output_tokens: this.config.max_output_tokens" },
  { file: "src/peers/openai.ts", field: "response.output_text.delta" },
  { file: "src/peers/anthropic.ts", field: "max_tokens: this.config.max_output_tokens" },
  { file: "src/peers/anthropic.ts", field: "thinking: anthropicThinking()" },
  { file: "src/peers/anthropic.ts", field: 'type: "adaptive"' },
  { file: "src/peers/anthropic.ts", field: "messages.stream" },
  { file: "src/peers/gemini.ts", field: "maxOutputTokens: this.config.max_output_tokens" },
  { file: "src/peers/gemini.ts", field: "thinkingConfig: geminiThinkingConfig(this.model)" },
  { file: "src/peers/gemini.ts", field: "ThinkingLevel.HIGH" },
  { file: "src/peers/gemini.ts", field: "generateContentStream" },
  { file: "src/peers/deepseek.ts", field: "max_tokens: this.config.max_output_tokens" },
  { file: "src/peers/deepseek.ts", field: 'type: "enabled"' },
  { file: "src/peers/deepseek.ts", field: "reasoning_effort:" },
  { file: "src/peers/deepseek.ts", field: "...deepSeekThinking(this.config)" },
  { file: "src/peers/deepseek.ts", field: "stream: true" },
  { file: "src/mcp/server.ts", field: "token_streaming: runtime.config.streaming.tokens" },
];

for (const { file, field } of adapterExpectations) {
  const source = fs.readFileSync(file, "utf8");
  assert.ok(source.includes(field), `${file} must use configurable ${field}`);
  assert.ok(!source.includes("4096"), `${file} must not keep the old 4096 output limit`);
  assert.ok(!source.includes("12000"), `${file} must not keep the temporary OpenAI limit`);
}

const modelSelectionSource = fs.readFileSync("src/peers/model-selection.ts", "utf8");
for (const deprecatedOrWeakModel of [
  "claude-haiku-4-5",
  "gemini-3-pro-preview",
  "deepseek-reasoner",
  "deepseek-chat",
]) {
  assert.ok(
    !modelSelectionSource.includes(`"${deprecatedOrWeakModel}"`),
    `${deprecatedOrWeakModel} must not be in active priority lists`,
  );
}

const noWeakDowngrade = selectFromCandidates(
  "claude",
  [{ id: "claude-haiku-4-5-20251001", source: "api" }],
  "claude-opus-4-7",
);
assert.equal(noWeakDowngrade.selected, "claude-opus-4-7");
assert.equal(noWeakDowngrade.confidence, "unknown");
assert.match(noWeakDowngrade.reason, /silently downgrading/);

const pemMarker = (side: "BEGIN" | "END", label: string): string =>
  ["-----", side, " ", label, "-----"].join("");
const pemBlock = (label: string, body = "not-a-real-key-material"): string =>
  [pemMarker("BEGIN", label), body, pemMarker("END", label)].join("\n");

for (const label of [
  "PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "EC PRIVATE KEY",
  "RSA PRIVATE KEY",
  "DSA PRIVATE KEY",
]) {
  assert.equal(redact(`prefix ${pemBlock(label)} suffix`), "prefix [REDACTED] suffix");
}

assert.equal(
  redact(
    [pemBlock("RSA PRIVATE KEY", "first"), "middle", pemBlock("EC PRIVATE KEY", "second")].join(
      "\r\n",
    ),
  ),
  "[REDACTED]\r\nmiddle\r\n[REDACTED]",
);

const mismatchedPem = [
  pemMarker("BEGIN", "OPENSSH PRIVATE KEY"),
  "legacy-compatible-redaction",
  pemMarker("END", "RSA PRIVATE KEY"),
].join("\n");
assert.equal(redact(`before ${mismatchedPem} after`), "before [REDACTED] after");

const overlappingPem = [
  pemMarker("BEGIN", "RSA PRIVATE KEY"),
  "outer-before",
  pemMarker("BEGIN", "EC PRIVATE KEY"),
  "inner",
  pemMarker("END", "EC PRIVATE KEY"),
  "outer-after",
  pemMarker("END", "RSA PRIVATE KEY"),
].join("\n");
assert.equal(redact(`before ${overlappingPem} after`), "before [REDACTED] after");

const unterminatedPem = `${pemMarker("BEGIN", "EC PRIVATE KEY")}\nmissing end`;
assert.equal(redact(unterminatedPem), unterminatedPem);

const completeThenUnterminated = [
  pemBlock("RSA PRIVATE KEY", "first"),
  "preserve this middle text",
  pemMarker("BEGIN", "RSA PRIVATE KEY"),
  "missing end",
].join("\n");
assert.equal(
  redact(completeThenUnterminated),
  [
    "[REDACTED]",
    "preserve this middle text",
    pemMarker("BEGIN", "RSA PRIVATE KEY"),
    "missing end",
  ].join("\n"),
);

const adversarialPem = `${pemMarker("BEGIN", "EC PRIVATE KEY")}\n${pemMarker(
  "BEGIN",
  "DSA PRIVATE KEY",
).repeat(2_000)}`;
const adversarialStarted = Date.now();
assert.equal(redact(adversarialPem), adversarialPem);
assert.equal(Date.now() - adversarialStarted < 1_000, true);

const repeatedSameLabelStarted = Date.now();
const repeatedSameLabel = pemMarker("BEGIN", "RSA PRIVATE KEY").repeat(2_000);
assert.equal(redact(repeatedSameLabel), repeatedSameLabel);
assert.equal(Date.now() - repeatedSameLabelStarted < 1_000, true);

const constructedToken = ["sk", "test", "A".repeat(24)].join("-");
assert.equal(redact(`token ${constructedToken}`), "token [REDACTED]");

const dashboardSource = fs.readFileSync(
  path.join(process.cwd(), "src", "dashboard", "server.ts"),
  "utf8",
);
assert.match(dashboardSource, /console\.error\("dashboard_request_failed"\)/);
assert.doesNotMatch(dashboardSource, /console\.error\(`dashboard_request_failed/);
assert.doesNotMatch(dashboardSource, /safeErrorMessage\(error\)/);

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
  review_focus: "services/billing",
  lead_peer: "codex",
  max_rounds: 2,
});

assert.equal(result.converged, true);
assert.ok(result.session.session_id);
assert.equal(result.session.review_focus, "services/billing");
assert.equal(result.session.rounds.length, 1);
assert.ok((result.session.generation_files?.length ?? 0) >= 1);
assert.equal(result.session.in_flight, undefined);
assert.equal(result.session.convergence_health?.state, "converged");
assert.ok((result.session.totals.usage.total_tokens ?? 0) > 0);
assert.ok(events.includes("round.completed"));

const finalPath = path.join(config.data_dir, "sessions", result.session.session_id, "final.md");
assert.equal(fs.existsSync(finalPath), true);
const reviewPromptPath = path.join(
  config.data_dir,
  "sessions",
  result.session.session_id,
  result.session.rounds[0]?.prompt_file ?? "",
);
const reviewPrompt = fs.readFileSync(reviewPromptPath, "utf8");
assert.match(reviewPrompt, /## Review Focus/);
assert.match(reviewPrompt, /services\/billing/);
assert.match(reviewPrompt, /OUT OF SCOPE/);
assert.ok(
  reviewPrompt.indexOf("## Review Focus") < reviewPrompt.indexOf("## Original Task"),
  "Review Focus must be front-loaded before the task body",
);
assert.doesNotMatch(reviewPrompt, /\/focus\s+services\/billing/);

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

const focusSecret = ["sk", "test", "B".repeat(24)].join("-");
const focusRedacted = await orchestrator.askPeers({
  task: "Verify review focus redaction and bounding.",
  review_focus: `/focus ${focusSecret} ${"x".repeat(2_500)}`,
  draft: "This draft is intentionally simple.",
  caller: "operator",
  peers: ["codex"],
});
assert.match(focusRedacted.session.review_focus ?? "", /\[REDACTED\]/);
assert.doesNotMatch(focusRedacted.session.review_focus ?? "", new RegExp(focusSecret));
assert.equal(
  (focusRedacted.session.review_focus ?? "").length <= config.prompt.max_review_focus_chars,
  true,
);
const focusPromptPath = path.join(
  config.data_dir,
  "sessions",
  focusRedacted.session.session_id,
  focusRedacted.session.rounds[0]?.prompt_file ?? "",
);
const focusPrompt = fs.readFileSync(focusPromptPath, "utf8");
assert.match(focusPrompt, /\[REDACTED\]/);
assert.match(focusPrompt, /OUT OF SCOPE/);
assert.doesNotMatch(focusPrompt, new RegExp(focusSecret));
assert.doesNotMatch(focusPrompt, /\/focus\s+/);
assert.doesNotMatch(focusPrompt, new RegExp("x".repeat(2_100)));

const formatRecovered = await orchestrator.askPeers({
  task: "Verify automatic parser format recovery.",
  review_focus: "recovery/focus",
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
const formatRecoveryPrompt = fs.readFileSync(
  path.join(
    config.data_dir,
    "sessions",
    formatRecovered.session.session_id,
    formatRecovered.session.rounds[0]?.prompt_file ?? "",
  ),
  "utf8",
);
assert.match(formatRecoveryPrompt, /## Review Focus/);
assert.match(formatRecoveryPrompt, /recovery\/focus/);
assert.match(formatRecoveryPrompt, /OUT OF SCOPE/);
assert.ok(
  formatRecoveryPrompt.indexOf("## Review Focus") <
    formatRecoveryPrompt.indexOf("## Original Task"),
  "Format recovery prompt must front-load Review Focus",
);

const emptyDecisionRecovered = await orchestrator.askPeers({
  task: "Verify automatic full decision retry after empty peer output.",
  review_focus: "recovery/focus",
  draft: "FORCE_EMPTY_REVIEW",
  caller: "operator",
  peers: ["codex"],
});
assert.equal(emptyDecisionRecovered.converged, true);
assert.equal(emptyDecisionRecovered.round.peers[0]?.status, "READY");
assert.equal(
  emptyDecisionRecovered.round.peers[0]?.parser_warnings.includes("decision_retry_succeeded"),
  true,
);
assert.equal(emptyDecisionRecovered.round.peers[0]?.decision_quality, "recovered");
const decisionRetryPrompt = fs.readFileSync(
  path.join(
    config.data_dir,
    "sessions",
    emptyDecisionRecovered.session.session_id,
    emptyDecisionRecovered.session.rounds[0]?.prompt_file ?? "",
  ),
  "utf8",
);
assert.match(decisionRetryPrompt, /## Review Focus/);
assert.match(decisionRetryPrompt, /recovery\/focus/);
assert.match(decisionRetryPrompt, /OUT OF SCOPE/);
assert.ok(
  decisionRetryPrompt.indexOf("## Review Focus") < decisionRetryPrompt.indexOf("## Original Task"),
  "Decision retry prompt must front-load Review Focus",
);

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
assert.equal(
  eventful.some((event) => event.type === "peer.token.delta"),
  true,
);
assert.equal(
  eventful.some((event) => event.type === "peer.token.completed"),
  true,
);
const tokenDelta = eventful.find((event) => event.type === "peer.token.delta");
assert.ok(tokenDelta);
assert.equal(typeof tokenDelta.data?.chars, "number");
assert.equal(Object.prototype.hasOwnProperty.call(tokenDelta.data ?? {}, "delta"), false);

const directStreamEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
const directStub = new StubAdapter(config, "codex");
const directStubResult = await directStub.call("Verify direct streaming equivalence.", {
  session_id: result.session.session_id,
  round: 99,
  task: "Verify direct streaming equivalence.",
  stream_tokens: true,
  emit(event) {
    directStreamEvents.push(event);
  },
});
const directStreamChars = directStreamEvents
  .filter((event) => event.type === "peer.token.delta")
  .reduce((total, event) => total + Number(event.data?.chars ?? 0), 0);
assert.equal(directStreamChars, directStubResult.text.length);
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
