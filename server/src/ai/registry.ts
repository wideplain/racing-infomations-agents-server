import type { AIProvider } from "./types.js";
import { CodexProvider } from "./codexProvider.js";
import { ClaudeProvider } from "./claudeProvider.js";
import type { Config } from "../config.js";

export function createProvider(config: Config): AIProvider {
  switch (config.aiProvider) {
    case "codex":
      return new CodexProvider({
        codexBin: config.codexBin,
        timeoutMs: config.analyzeTimeoutMs,
        codexHome: config.codexHome,
      });
    case "claude":
      return new ClaudeProvider();
    default:
      throw new Error(`Unknown AI_PROVIDER: ${config.aiProvider}`);
  }
}
