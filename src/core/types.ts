export const PEERS = ["codex", "claude", "gemini", "deepseek"] as const;
export type PeerId = (typeof PEERS)[number];

export const STATUSES = ["READY", "NOT_READY", "NEEDS_EVIDENCE"] as const;
export type ReviewStatus = (typeof STATUSES)[number];

export type Confidence = "verified" | "inferred" | "unknown";
export type SessionOutcome = "converged" | "aborted" | "max-rounds";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCandidate {
  id: string;
  display_name?: string;
  source: "api" | "documented-priority" | "env-override";
  metadata?: Record<string, unknown>;
}

export interface ModelSelection {
  peer: PeerId;
  selected: string;
  candidates: ModelCandidate[];
  source_url: string;
  reason: string;
  confidence: Confidence;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
}

export interface CostEstimate {
  currency: "USD";
  input_cost?: number;
  output_cost?: number;
  total_cost?: number;
  estimated: boolean;
  source: "configured-rate" | "unknown-rate";
}

export interface PeerStructuredStatus {
  status: ReviewStatus;
  summary?: string;
  confidence?: Confidence;
  evidence_sources?: string[];
  caller_requests?: string[];
  follow_ups?: string[];
}

export interface PeerResult {
  peer: PeerId;
  provider: string;
  model: string;
  model_reported?: string;
  model_match?: boolean;
  status: ReviewStatus | null;
  structured: PeerStructuredStatus | null;
  text: string;
  raw: unknown;
  usage?: TokenUsage;
  cost?: CostEstimate;
  latency_ms: number;
  attempts: number;
  parser_warnings: string[];
}

export interface GenerationResult {
  peer: PeerId;
  provider: string;
  model: string;
  model_reported?: string;
  model_match?: boolean;
  text: string;
  raw: unknown;
  usage?: TokenUsage;
  cost?: CostEstimate;
  latency_ms: number;
  attempts: number;
}

export interface PeerFailure {
  peer: PeerId;
  provider: string;
  model?: string;
  failure_class:
    | "auth"
    | "rate_limit"
    | "prompt_flagged_by_moderation"
    | "silent_model_downgrade"
    | "provider_error"
    | "network"
    | "timeout"
    | "schema"
    | "unknown";
  message: string;
  retryable: boolean;
  recovery_hint?: "wait_and_retry" | "reformulate_and_retry";
  reformulation_advice?: string;
  retry_after_ms?: number;
  attempts: number;
  latency_ms: number;
}

export interface InFlightRound {
  round: number;
  peers: PeerId[];
  started_at: string;
  status: "running";
}

export interface ConvergenceScope {
  caller: PeerId | "operator";
  caller_status: ReviewStatus;
  expected_peers: PeerId[];
  reviewer_peers: PeerId[];
  lead_peer?: PeerId;
}

export interface ConvergenceHealth {
  state: "idle" | "running" | "converged" | "blocked" | "stale";
  last_event_at: string;
  detail: string;
  idle_ms?: number;
}

export interface EvidenceAttachment {
  ts: string;
  label: string;
  path: string;
  content_type?: string;
}

export interface OperatorEscalation {
  ts: string;
  reason: string;
  severity: "info" | "warning" | "critical";
}

export interface PeerAdapter {
  id: PeerId;
  provider: string;
  model: string;
  call(prompt: string, context: PeerCallContext): Promise<PeerResult>;
  generate(prompt: string, context: PeerCallContext): Promise<GenerationResult>;
  probe(): Promise<PeerProbeResult>;
}

export interface PeerCallContext {
  session_id: string;
  round: number;
  task: string;
  signal?: AbortSignal;
  stream?: boolean;
  emit(event: RuntimeEvent): void;
}

export interface PeerProbeResult {
  peer: PeerId;
  provider: string;
  model: string;
  available: boolean;
  auth_present: boolean;
  latency_ms: number;
  model_selection?: ModelSelection;
  message?: string;
}

export interface RuntimeEvent {
  type: string;
  ts?: string;
  session_id?: string;
  round?: number;
  peer?: PeerId;
  message?: string;
  data?: Record<string, unknown>;
}

export interface SessionMeta {
  session_id: string;
  version: string;
  created_at: string;
  updated_at: string;
  task: string;
  caller: PeerId | "operator";
  outcome?: SessionOutcome;
  outcome_reason?: string;
  capability_snapshot: PeerProbeResult[];
  in_flight?: InFlightRound;
  convergence_scope?: ConvergenceScope;
  convergence_health?: ConvergenceHealth;
  failed_attempts?: Array<PeerFailure & { round: number }>;
  evidence_files?: EvidenceAttachment[];
  operator_escalations?: OperatorEscalation[];
  rounds: ReviewRound[];
  totals: {
    usage: TokenUsage;
    cost: CostEstimate;
  };
}

export interface ReviewRound {
  round: number;
  started_at: string;
  completed_at?: string;
  caller_status: ReviewStatus;
  draft_file?: string;
  prompt_file: string;
  peers: PeerResult[];
  rejected: PeerFailure[];
  convergence: ConvergenceResult;
}

export interface ConvergenceResult {
  converged: boolean;
  reason: string;
  latest_round_converged?: boolean;
  session_quorum_converged?: boolean;
  recovery_converged?: boolean;
  quorum_peers?: PeerId[];
  ready_peers: PeerId[];
  not_ready_peers: PeerId[];
  needs_evidence_peers: PeerId[];
  rejected_peers: PeerId[];
}

export interface AppConfig {
  version: string;
  data_dir: string;
  log_level: string;
  stub: boolean;
  dashboard_port: number;
  retry: {
    max_attempts: number;
    base_delay_ms: number;
    max_delay_ms: number;
    timeout_ms: number;
  };
  models: Record<PeerId, string>;
  reasoning_effort: Partial<Record<PeerId, ReasoningEffort>>;
  model_selection: Partial<Record<PeerId, ModelSelection>>;
  api_keys: Record<PeerId, string | undefined>;
  cost_rates: Partial<Record<PeerId, { input_per_million: number; output_per_million: number }>>;
}
