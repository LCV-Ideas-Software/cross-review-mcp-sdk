import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AppConfig, PeerId } from "./types.js";

export const VERSION = "2.0.4-alpha.0";
export const RELEASE_DATE = "2026-04-29";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_ROOT = path.resolve(__dirname, "..", "..");
const PROJECT_ROOT =
  path.basename(RUNTIME_ROOT).toLowerCase() === "dist"
    ? path.resolve(RUNTIME_ROOT, "..")
    : RUNTIME_ROOT;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readWindowsRegistryEnv(name: string): string | undefined {
  if (process.platform !== "win32") return undefined;

  const roots = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];

  for (const root of roots) {
    try {
      const output = execFileSync("reg", ["query", root, "/v", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const match = output.match(
        new RegExp(`^\\s*${escapeRegExp(name)}\\s+REG_\\w+\\s+(.*)$`, "im"),
      );
      const value = match?.[1]?.trim();
      if (value) return value;
    } catch {
      // Missing values are expected when users store a key in another scope.
    }
  }

  return undefined;
}

function envValue(name: string): string | undefined {
  const processValue = process.env[name];
  if (processValue) return processValue;

  const registryValue = readWindowsRegistryEnv(name);
  if (registryValue) {
    process.env[name] = registryValue;
    return registryValue;
  }

  return undefined;
}

function boolEnv(name: string, fallback = false): boolean {
  const value = envValue(name);
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(envValue(name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberEnv(name: string): number | undefined {
  const parsed = Number.parseFloat(envValue(name) ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function keyForPeer(peer: PeerId): string | undefined {
  switch (peer) {
    case "codex":
      return envValue("OPENAI_API_KEY");
    case "claude":
      return envValue("ANTHROPIC_API_KEY");
    case "gemini":
      return envValue("GEMINI_API_KEY");
    case "deepseek":
      return envValue("DEEPSEEK_API_KEY");
  }
}

function reasoningEffort(
  name: string,
  fallback: AppConfig["reasoning_effort"][PeerId],
): AppConfig["reasoning_effort"][PeerId] {
  const value = envValue(name);
  if (!value) return fallback;
  if (/^(none|minimal|low|medium|high|xhigh|max)$/i.test(value)) {
    return value.toLowerCase() as AppConfig["reasoning_effort"][PeerId];
  }
  return fallback;
}

export function loadConfig(): AppConfig {
  const configuredDataDir = envValue("CROSS_REVIEW_SDK_DATA_DIR");
  const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : path.join(PROJECT_ROOT, "data");

  return {
    version: VERSION,
    data_dir: dataDir,
    log_level: envValue("CROSS_REVIEW_SDK_LOG_LEVEL") || "info",
    stub: boolEnv("CROSS_REVIEW_SDK_STUB", false),
    dashboard_port: intEnv("CROSS_REVIEW_SDK_DASHBOARD_PORT", 4588),
    retry: {
      max_attempts: intEnv("CROSS_REVIEW_SDK_RETRY_ATTEMPTS", 3),
      base_delay_ms: intEnv("CROSS_REVIEW_SDK_RETRY_BASE_MS", 1000),
      max_delay_ms: intEnv("CROSS_REVIEW_SDK_RETRY_MAX_MS", 30000),
      timeout_ms: intEnv("CROSS_REVIEW_SDK_TIMEOUT_MS", 30 * 60 * 1000),
    },
    budget: {
      max_session_cost_usd: numberEnv("CROSS_REVIEW_SDK_MAX_SESSION_COST_USD"),
    },
    models: {
      codex: envValue("CROSS_REVIEW_OPENAI_MODEL") || "gpt-5.5",
      claude: envValue("CROSS_REVIEW_ANTHROPIC_MODEL") || "claude-opus-4-7",
      gemini: envValue("CROSS_REVIEW_GEMINI_MODEL") || "gemini-3.1-pro-preview",
      deepseek: envValue("CROSS_REVIEW_DEEPSEEK_MODEL") || "deepseek-v4-pro",
    },
    reasoning_effort: {
      codex: reasoningEffort("CROSS_REVIEW_OPENAI_REASONING_EFFORT", "xhigh"),
      claude: reasoningEffort("CROSS_REVIEW_ANTHROPIC_REASONING_EFFORT", "max"),
    },
    model_selection: {},
    api_keys: {
      codex: keyForPeer("codex"),
      claude: keyForPeer("claude"),
      gemini: keyForPeer("gemini"),
      deepseek: keyForPeer("deepseek"),
    },
    cost_rates: {
      codex: costRate("CROSS_REVIEW_OPENAI"),
      claude: costRate("CROSS_REVIEW_ANTHROPIC"),
      gemini: costRate("CROSS_REVIEW_GEMINI"),
      deepseek: costRate("CROSS_REVIEW_DEEPSEEK"),
    },
  };
}

function costRate(
  prefix: string,
): { input_per_million: number; output_per_million: number } | undefined {
  const input = numberEnv(`${prefix}_INPUT_USD_PER_MILLION`);
  const output = numberEnv(`${prefix}_OUTPUT_USD_PER_MILLION`);
  if (input == null || output == null) return undefined;
  return { input_per_million: input, output_per_million: output };
}
