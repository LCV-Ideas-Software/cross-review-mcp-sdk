import type { SessionEvent, SessionMeta } from "./types.js";

function valueOrDash(value: unknown): string {
  if (value == null || value === "") return "-";
  return String(value);
}

function costText(session: SessionMeta): string {
  const total = session.totals.cost.total_cost;
  return total == null ? "unknown" : `$${total.toFixed(6)} ${session.totals.cost.currency}`;
}

export function sessionReportMarkdown(session: SessionMeta, events: SessionEvent[] = []): string {
  const latestRound = session.rounds.at(-1);
  const lines = [
    `# Cross Review Session ${session.session_id}`,
    "",
    "## Summary",
    "",
    `- Version: ${session.version}`,
    `- Created: ${session.created_at}`,
    `- Updated: ${session.updated_at}`,
    `- Caller: ${session.caller}`,
    `- Outcome: ${valueOrDash(session.outcome)}`,
    `- Outcome reason: ${valueOrDash(session.outcome_reason)}`,
    `- Health: ${valueOrDash(session.convergence_health?.state)} - ${valueOrDash(
      session.convergence_health?.detail,
    )}`,
    `- Rounds: ${session.rounds.length}`,
    `- Cost: ${costText(session)}`,
    `- Total tokens: ${valueOrDash(session.totals.usage.total_tokens)}`,
    "",
    "## Task",
    "",
    session.task,
    "",
    "## Latest Convergence",
    "",
    latestRound
      ? [
          `- Converged: ${latestRound.convergence.converged}`,
          `- Reason: ${latestRound.convergence.reason}`,
          `- Ready: ${latestRound.convergence.ready_peers.join(", ") || "-"}`,
          `- Not ready: ${latestRound.convergence.not_ready_peers.join(", ") || "-"}`,
          `- Needs evidence: ${latestRound.convergence.needs_evidence_peers.join(", ") || "-"}`,
          `- Rejected: ${latestRound.convergence.rejected_peers.join(", ") || "-"}`,
          `- Blocking details: ${latestRound.convergence.blocking_details.join("; ") || "-"}`,
        ].join("\n")
      : "- No round completed yet.",
    "",
    "## Peer Decisions",
    "",
  ];

  if (session.generation_files?.length) {
    lines.push("## Generations", "");
    for (const generation of session.generation_files) {
      const totalTokens = generation.usage?.total_tokens ?? "-";
      const totalCost =
        generation.cost?.total_cost == null
          ? "unknown"
          : `$${generation.cost.total_cost.toFixed(6)} ${generation.cost.currency}`;
      lines.push(
        `- round ${generation.round} ${generation.peer}/${generation.label}: ${generation.path} (${totalTokens} tokens, ${totalCost})`,
      );
    }
    lines.push("");
  }

  for (const round of session.rounds) {
    lines.push(`### Round ${round.round}`, "");
    for (const peer of round.peers) {
      lines.push(
        `- ${peer.peer}: ${peer.status ?? "NO_STATUS"} (${peer.decision_quality ?? "unknown"}) - ${
          peer.structured?.summary ?? "no summary"
        }`,
      );
      if (peer.parser_warnings.length) {
        lines.push(`  - Parser warnings: ${peer.parser_warnings.join("; ")}`);
      }
    }
    for (const failure of round.rejected) {
      lines.push(`- ${failure.peer}: FAILURE ${failure.failure_class} - ${failure.message}`);
    }
    lines.push("");
  }

  if (events.length) {
    lines.push("## Events", "");
    for (const event of events.slice(-100)) {
      lines.push(
        `- ${event.seq}. ${event.ts ?? ""} ${event.type}${
          event.peer ? `/${event.peer}` : ""
        }: ${event.message ?? ""}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
