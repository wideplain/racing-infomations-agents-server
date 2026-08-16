import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CodexProvider, PITWALL_SCHEMA_PATH } from "../src/ai/codexProvider.js";
import { parsePitwallAnalysis } from "../src/analysis/parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(__dirname, "fixtures", name);

describe("CodexProvider", () => {
  it("reads the answer from --output-last-message on success", async () => {
    const provider = new CodexProvider({
      codexBin: fixture("fake-codex-success.sh"),
      timeoutMs: 5000,
    });
    const result = await provider.analyze({ prompt: "hello" });
    expect(result.parseFallback).toBe(false);
    expect(result.summary).toBe("テストの要約です。");
    expect(result.advice).toEqual(["アドバイス1", "アドバイス2"]);
    expect(result.confidence).toBe(0.8);
  });

  it("retries once and then throws on non-zero exit", async () => {
    const provider = new CodexProvider({
      codexBin: fixture("fake-codex-exit1.sh"),
      timeoutMs: 5000,
    });
    await expect(provider.analyze({ prompt: "hello" })).rejects.toThrow(
      /exit_code_1/
    );
  });

  it("retries once and then throws on empty output", async () => {
    const provider = new CodexProvider({
      codexBin: fixture("fake-codex-empty.sh"),
      timeoutMs: 5000,
    });
    await expect(provider.analyze({ prompt: "hello" })).rejects.toThrow(
      /empty_output/
    );
  });

  it("passes a per-call schemaPath through to codex exec (pitwall shape parses via parsePitwallAnalysis)", async () => {
    const provider = new CodexProvider({
      codexBin: fixture("fake-codex-pitwall-success.sh"),
      timeoutMs: 5000,
    });
    const result = await provider.analyze({
      prompt: "hello",
      schemaPath: PITWALL_SCHEMA_PATH,
    });
    const parsed = parsePitwallAnalysis(result.rawOutput);
    expect(parsed.parseFallback).toBe(false);
    expect(parsed.statusSummary).toBe("1周目、順調に走行中。");
    expect(parsed.confidence).toBe("medium");
    expect(parsed.needsReview).toBe(true);
    expect(parsed.warnings).toEqual(["燃料量は聞き取れませんでした"]);
  });

  it("kills a hung process after the timeout and retries, then throws", async () => {
    const provider = new CodexProvider({
      codexBin: fixture("fake-codex-timeout.sh"),
      timeoutMs: 300,
    });
    await expect(provider.analyze({ prompt: "hello" })).rejects.toThrow(
      /timeout/
    );
  }, 15000);
});
