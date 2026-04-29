import type { ConvergenceResult, PeerFailure, PeerId, PeerResult, ReviewStatus } from "./types.js";

export function checkConvergence(
  expectedPeers: PeerId[],
  callerStatus: ReviewStatus,
  peers: PeerResult[],
  rejected: PeerFailure[],
): ConvergenceResult {
  const ready = peers.filter((p) => p.status === "READY").map((p) => p.peer);
  const notReady = peers.filter((p) => p.status === "NOT_READY").map((p) => p.peer);
  const needsEvidence = peers
    .filter((p) => p.status === "NEEDS_EVIDENCE" || p.status == null)
    .map((p) => p.peer);
  const rejectedPeers = rejected.map((f) => f.peer);
  const responded = new Set(peers.map((p) => p.peer));
  const missing = expectedPeers.filter((p) => !responded.has(p) && !rejectedPeers.includes(p));
  const decisionQuality = Object.fromEntries(
    peers.map((peer) => [peer.peer, peer.decision_quality]),
  ) as ConvergenceResult["decision_quality"];
  const blockingDetails = [
    ...notReady.map((peer) => `${peer}: NOT_READY`),
    ...needsEvidence.map((peer) => `${peer}: NEEDS_EVIDENCE`),
    ...rejected.map((failure) => `${failure.peer}: ${failure.failure_class}`),
    ...missing.map((peer) => `${peer}: missing response`),
  ];

  if (callerStatus !== "READY") {
    return {
      converged: false,
      reason: `caller_status=${callerStatus}; caller must be READY`,
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: [...rejectedPeers, ...missing],
      decision_quality: decisionQuality,
      blocking_details: [`caller_status=${callerStatus}`, ...blockingDetails],
    };
  }
  if (rejectedPeers.length || missing.length) {
    return {
      converged: false,
      reason: "one or more peers failed or did not respond",
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: [...rejectedPeers, ...missing],
      decision_quality: decisionQuality,
      blocking_details: blockingDetails,
    };
  }
  if (notReady.length || needsEvidence.length) {
    return {
      converged: false,
      reason: "at least one peer did not declare READY",
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: [],
      decision_quality: decisionQuality,
      blocking_details: blockingDetails,
    };
  }
  if (ready.length !== expectedPeers.length) {
    return {
      converged: false,
      reason: "not all expected peers responded READY",
      ready_peers: ready,
      not_ready_peers: notReady,
      needs_evidence_peers: needsEvidence,
      rejected_peers: missing,
      decision_quality: decisionQuality,
      blocking_details: blockingDetails,
    };
  }
  return {
    converged: true,
    reason: "caller and all peers declared READY with no rejected peers",
    ready_peers: ready,
    not_ready_peers: [],
    needs_evidence_peers: [],
    rejected_peers: [],
    decision_quality: decisionQuality,
    blocking_details: [],
  };
}
