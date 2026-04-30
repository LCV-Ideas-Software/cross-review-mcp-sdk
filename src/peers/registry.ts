import type { AppConfig, PeerAdapter, PeerId } from "../core/types.js";
import { PEERS } from "../core/types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAIAdapter } from "./openai.js";
import { StubAdapter } from "./stub.js";

export function createAdapters(
  config: AppConfig,
  modelOverrides: Partial<Record<PeerId, string>> = {},
): Record<PeerId, PeerAdapter> {
  if (config.stub) {
    return {
      codex: new StubAdapter(config, "codex", modelOverrides.codex),
      claude: new StubAdapter(config, "claude", modelOverrides.claude),
      gemini: new StubAdapter(config, "gemini", modelOverrides.gemini),
      deepseek: new StubAdapter(config, "deepseek", modelOverrides.deepseek),
    };
  }

  return {
    codex: new OpenAIAdapter(config, modelOverrides.codex),
    claude: new AnthropicAdapter(config, modelOverrides.claude),
    gemini: new GeminiAdapter(config, modelOverrides.gemini),
    deepseek: new DeepSeekAdapter(config, modelOverrides.deepseek),
  };
}

export function selectAdapters(
  adapters: Record<PeerId, PeerAdapter>,
  peers: PeerId[] = [...PEERS],
): PeerAdapter[] {
  return peers.map((peer) => adapters[peer]);
}
