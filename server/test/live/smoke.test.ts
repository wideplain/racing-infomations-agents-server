import { describe, it, expect } from "vitest";
import { CodexProvider } from "../../src/ai/codexProvider.js";
import { buildPrompt } from "../../src/analysis/prompt.js";

// Single real-codex smoke test. Run manually with `npm run test:live`.
// Not part of `npm test` (excluded via vitest.config.ts) since it requires
// an authenticated local `codex` CLI and network/model access.
describe("codex exec live smoke test", () => {
  it("returns a structured analysis for a tiny transcript", async () => {
    const provider = new CodexProvider({
      codexBin: process.env.CODEX_BIN ?? "codex",
      timeoutMs: 120000,
    });

    const prompt = buildPrompt(
      [
        { clientSeq: 1, text: "明日の会議の資料はもう準備できましたか？", createdAt: new Date().toISOString() },
        { clientSeq: 2, text: "まだです、今日中に終わらせます。", createdAt: new Date().toISOString() },
      ],
      new Date().toISOString()
    );

    const result = await provider.analyze({ prompt });

    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  }, 130000);
});
