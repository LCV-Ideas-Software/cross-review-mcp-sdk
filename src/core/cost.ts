import type { AppConfig, CostEstimate, PeerId, TokenUsage } from "./types.js";

export function mergeUsage(items: Array<TokenUsage | undefined>): TokenUsage {
  const total: TokenUsage = {};
  for (const item of items) {
    if (!item) continue;
    total.input_tokens = (total.input_tokens ?? 0) + (item.input_tokens ?? 0);
    total.output_tokens = (total.output_tokens ?? 0) + (item.output_tokens ?? 0);
    total.total_tokens = (total.total_tokens ?? 0) + (item.total_tokens ?? 0);
    total.reasoning_tokens = (total.reasoning_tokens ?? 0) + (item.reasoning_tokens ?? 0);
  }
  return total;
}

export function estimateCost(config: AppConfig, peer: PeerId, usage?: TokenUsage): CostEstimate {
  const rate = config.cost_rates[peer];
  if (!usage || !rate) {
    return { currency: "USD", estimated: false, source: "unknown-rate" };
  }
  const input = ((usage.input_tokens ?? 0) / 1_000_000) * rate.input_per_million;
  const output = ((usage.output_tokens ?? 0) / 1_000_000) * rate.output_per_million;
  return {
    currency: "USD",
    input_cost: input,
    output_cost: output,
    total_cost: input + output,
    estimated: true,
    source: "configured-rate",
  };
}

export function mergeCost(costs: Array<CostEstimate | undefined>): CostEstimate {
  let known = false;
  let total = 0;
  for (const cost of costs) {
    if (cost?.total_cost == null) continue;
    known = true;
    total += cost.total_cost;
  }
  return known
    ? { currency: "USD", total_cost: total, estimated: true, source: "configured-rate" }
    : { currency: "USD", estimated: false, source: "unknown-rate" };
}
