import type { AIProvider, AnalyzeInput, AnalyzeOutput } from "./types.js";

/**
 * Stub provider for `claude -p --output-format json`. Not implemented in
 * Phase 1; present so AI_PROVIDER=claude fails clearly instead of silently
 * falling back to codex.
 */
export class ClaudeProvider implements AIProvider {
  name = "claude";

  async analyze(_input: AnalyzeInput): Promise<AnalyzeOutput> {
    throw new Error("ClaudeProvider is not implemented yet");
  }

  async healthcheck(): Promise<boolean> {
    return false;
  }
}
