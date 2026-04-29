import type { AppConfig, PeerAdapter, PeerId } from "../core/types.js";
import { PEERS } from "../core/types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAIAdapter } from "./openai.js";
import { StubAdapter } from "./stub.js";

export function createAdapters(config: AppConfig): Record<PeerId, PeerAdapter> {
  if (config.stub) {
    return {
      codex: new StubAdapter(config, "codex"),
      claude: new StubAdapter(config, "claude"),
      gemini: new StubAdapter(config, "gemini"),
      deepseek: new StubAdapter(config, "deepseek"),
    };
  }

  return {
    codex: new OpenAIAdapter(config),
    claude: new AnthropicAdapter(config),
    gemini: new GeminiAdapter(config),
    deepseek: new DeepSeekAdapter(config),
  };
}

export function selectAdapters(
  adapters: Record<PeerId, PeerAdapter>,
  peers: PeerId[] = [...PEERS],
): PeerAdapter[] {
  return peers.map((peer) => adapters[peer]);
}
