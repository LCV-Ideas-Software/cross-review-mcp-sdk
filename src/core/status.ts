import { z } from "zod";
import type { PeerStructuredStatus, ReviewStatus } from "./types.js";

const STATUS_VALUES = ["READY", "NOT_READY", "NEEDS_EVIDENCE"] as const satisfies ReviewStatus[];
const CONFIDENCE_VALUES = ["verified", "inferred", "unknown"] as const;
const MAX_FIELD_LENGTH = 800;
const MAX_ARRAY_ITEMS = 30;

export const statusSchema = z.object({
  status: z.enum(["READY", "NOT_READY", "NEEDS_EVIDENCE"]),
  summary: z.string().max(MAX_FIELD_LENGTH).optional(),
  confidence: z.enum(["verified", "inferred", "unknown"]).optional(),
  evidence_sources: z.array(z.string().max(MAX_FIELD_LENGTH)).max(MAX_ARRAY_ITEMS).optional(),
  caller_requests: z.array(z.string().max(MAX_FIELD_LENGTH)).max(MAX_ARRAY_ITEMS).optional(),
  follow_ups: z.array(z.string().max(MAX_FIELD_LENGTH)).max(MAX_ARRAY_ITEMS).optional(),
});

export const statusJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "confidence",
    "evidence_sources",
    "caller_requests",
    "follow_ups",
  ],
  properties: {
    status: { type: "string", enum: ["READY", "NOT_READY", "NEEDS_EVIDENCE"] },
    summary: { type: "string" },
    confidence: { type: "string", enum: ["verified", "inferred", "unknown"] },
    evidence_sources: { type: "array", items: { type: "string" } },
    caller_requests: { type: "array", items: { type: "string" } },
    follow_ups: { type: "array", items: { type: "string" } },
  },
} as const;

const OPEN_TAG = "<cross_review_status>";
const CLOSE_TAG = "</cross_review_status>";

export function statusInstruction(): string {
  return [
    "Return a rigorous peer review.",
    "Review only the caller artifact above; do not review these response-format instructions.",
    "You must end with one machine-readable JSON object that matches this shape:",
    JSON.stringify(statusJsonSchema),
    `Keep summary and every string field at or below ${MAX_FIELD_LENGTH} characters.`,
    "Do not invent evidence. If evidence is missing, use NEEDS_EVIDENCE.",
    "READY means you have no remaining blocking objection.",
    "NOT_READY means concrete corrections remain.",
    "NEEDS_EVIDENCE means you require specific external evidence before deciding.",
  ].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && STATUS_VALUES.includes(value as ReviewStatus);
}

function truncateField(field: string, value: string, warnings: string[]): string {
  if (value.length <= MAX_FIELD_LENGTH) return value;
  warnings.push(`${field}_truncated_to_${MAX_FIELD_LENGTH}`);
  return `${value.slice(0, MAX_FIELD_LENGTH - 3)}...`;
}

function normalizeStringArray(
  field: keyof Pick<PeerStructuredStatus, "evidence_sources" | "caller_requests" | "follow_ups">,
  value: unknown,
  warnings: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warnings.push(`${field}_dropped_non_array`);
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length) warnings.push(`${field}_dropped_non_string_items`);
  if (strings.length > MAX_ARRAY_ITEMS)
    warnings.push(`${field}_truncated_to_${MAX_ARRAY_ITEMS}_items`);

  return strings
    .slice(0, MAX_ARRAY_ITEMS)
    .map((item, index) => truncateField(`${field}_${index}`, item, warnings));
}

function normalizeStructuredStatus(
  value: unknown,
  warnings: string[],
): PeerStructuredStatus | null {
  if (!isObject(value) || !isReviewStatus(value.status)) return null;

  const normalized: PeerStructuredStatus = { status: value.status };

  if (typeof value.summary === "string") {
    normalized.summary = truncateField("summary", value.summary, warnings);
  } else if (value.summary !== undefined) {
    warnings.push("summary_dropped_non_string");
  }

  if (
    typeof value.confidence === "string" &&
    CONFIDENCE_VALUES.includes(value.confidence as never)
  ) {
    normalized.confidence = value.confidence as PeerStructuredStatus["confidence"];
  } else if (value.confidence !== undefined) {
    warnings.push("confidence_dropped_invalid_value");
  }

  const evidenceSources = normalizeStringArray(
    "evidence_sources",
    value.evidence_sources,
    warnings,
  );
  if (evidenceSources) normalized.evidence_sources = evidenceSources;

  const callerRequests = normalizeStringArray("caller_requests", value.caller_requests, warnings);
  if (callerRequests) normalized.caller_requests = callerRequests;

  const followUps = normalizeStringArray("follow_ups", value.follow_ups, warnings);
  if (followUps) normalized.follow_ups = followUps;

  const parsed = statusSchema.safeParse(normalized);
  if (!parsed.success) {
    warnings.push(`status_normalization_failed:${parsed.error.message.slice(0, 300)}`);
    return null;
  }

  return parsed.data;
}

function extractJsonKeyStatus(candidate: string): ReviewStatus | null {
  const match = candidate.match(/"status"\s*:\s*"(READY|NOT_READY|NEEDS_EVIDENCE)"/);
  return match ? (match[1] as ReviewStatus) : null;
}

export function parsePeerStatus(text: string): {
  status: ReviewStatus | null;
  structured: PeerStructuredStatus | null;
  parser_warnings: string[];
} {
  const warnings: string[] = [];
  const trimmed = text.trim();
  const candidates: Array<{ json: string; source: string }> = [];

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push({ json: trimmed, source: "raw_object" });
  }

  const openAt = trimmed.lastIndexOf(OPEN_TAG);
  const closeAt = trimmed.lastIndexOf(CLOSE_TAG);
  if (openAt >= 0 && closeAt > openAt) {
    candidates.push({
      json: trimmed.slice(openAt + OPEN_TAG.length, closeAt).trim(),
      source: "status_tag",
    });
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [];
  for (const block of fenced.reverse()) {
    candidates.push({
      json: block
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim(),
      source: "fenced_json",
    });
  }

  const lastBrace = trimmed.lastIndexOf("{");
  if (lastBrace >= 0) candidates.push({ json: trimmed.slice(lastBrace), source: "last_brace" });

  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate.json) as unknown;
      const parsed = statusSchema.safeParse(json);
      if (parsed.success) {
        if (candidate.source === "fenced_json") warnings.push("status_json_extracted_from_fence");
        if (candidate.source === "status_tag") warnings.push("status_json_extracted_from_tag");
        return {
          status: parsed.data.status,
          structured: parsed.data,
          parser_warnings: warnings,
        };
      }

      const recoveryWarnings = [...warnings, parsed.error.message.slice(0, 500)];
      const normalized = normalizeStructuredStatus(json, recoveryWarnings);
      if (normalized) {
        if (candidate.source === "fenced_json")
          recoveryWarnings.push("status_json_extracted_from_fence");
        if (candidate.source === "status_tag")
          recoveryWarnings.push("status_json_extracted_from_tag");
        recoveryWarnings.push("status_json_recovered_after_schema_warning");
        return {
          status: normalized.status,
          structured: normalized,
          parser_warnings: recoveryWarnings,
        };
      }

      warnings.push(parsed.error.message.slice(0, 500));
    } catch {
      const recoveredStatus = extractJsonKeyStatus(candidate.json);
      if (recoveredStatus) {
        warnings.push(`status_recovered_from_invalid_json:${candidate.source}`);
        return {
          status: recoveredStatus,
          structured: { status: recoveredStatus },
          parser_warnings: warnings,
        };
      }
    }
  }

  const legacy = trimmed.match(/STATUS:\s*(READY|NOT_READY|NEEDS_EVIDENCE)\s*$/);
  if (legacy) {
    return {
      status: legacy[1] as ReviewStatus,
      structured: { status: legacy[1] as ReviewStatus },
      parser_warnings: warnings,
    };
  }

  return { status: null, structured: null, parser_warnings: warnings };
}
