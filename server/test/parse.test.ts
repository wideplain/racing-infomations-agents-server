import { describe, it, expect } from "vitest";
import { parseAnalysis, parsePitwallAnalysis, parseDriverAnalysis } from "../src/analysis/parse.js";

describe("parseAnalysis", () => {
  it("parses a plain JSON object", () => {
    const raw = JSON.stringify({
      summary: "s",
      interpretation: "i",
      advice: ["a1", "a2"],
      suggested_response: "r",
      confidence: 0.5,
      notes: "n",
    });
    const result = parseAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.summary).toBe("s");
    expect(result.advice).toEqual(["a1", "a2"]);
    expect(result.confidence).toBe(0.5);
  });

  it("parses JSON wrapped in a code fence", () => {
    const raw = [
      "```json",
      JSON.stringify({
        summary: "s",
        interpretation: "i",
        advice: [],
        suggested_response: "r",
      }),
      "```",
    ].join("\n");
    const result = parseAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.summary).toBe("s");
  });

  it("extracts JSON preceded by prose", () => {
    const json = JSON.stringify({
      summary: "s",
      interpretation: "i",
      advice: ["x"],
      suggested_response: "r",
    });
    const raw = `以下が結果です。\n${json}\nご確認ください。`;
    const result = parseAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.summary).toBe("s");
    expect(result.advice).toEqual(["x"]);
  });

  it("falls back to raw text summary for pure prose", () => {
    const raw = "これはJSONではない普通の文章です。";
    const result = parseAnalysis(raw);
    expect(result.parseFallback).toBe(true);
    expect(result.summary).toBe(raw);
    expect(result.advice).toEqual([]);
  });

  it("null-fills missing fields via zod when JSON is partial", () => {
    const raw = JSON.stringify({ summary: "s only" });
    const result = parseAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.summary).toBe("s only");
    expect(result.interpretation).toBe("");
    expect(result.advice).toEqual([]);
    expect(result.suggested_response).toBe("");
    expect(result.confidence).toBeNull();
  });
});

describe("parsePitwallAnalysis", () => {
  it("parses a plain JSON object", () => {
    const raw = JSON.stringify({
      statusSummary: "s",
      change: "c",
      question: "q",
      proposal: "p",
      confidence: "high",
      needsReview: true,
      facts: ["f1"],
      warnings: ["w1"],
    });
    const result = parsePitwallAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.statusSummary).toBe("s");
    expect(result.confidence).toBe("high");
    expect(result.needsReview).toBe(true);
    expect(result.facts).toEqual(["f1"]);
    expect(result.warnings).toEqual(["w1"]);
  });

  it("parses JSON wrapped in a code fence", () => {
    const raw = [
      "```json",
      JSON.stringify({
        statusSummary: "s",
        change: "c",
        question: "q",
        proposal: "p",
      }),
      "```",
    ].join("\n");
    const result = parsePitwallAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.statusSummary).toBe("s");
  });

  it("extracts JSON preceded by prose", () => {
    const json = JSON.stringify({
      statusSummary: "s",
      change: "c",
      question: "q",
      proposal: "p",
      facts: ["x"],
    });
    const raw = `以下が結果です。\n${json}\nご確認ください。`;
    const result = parsePitwallAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.statusSummary).toBe("s");
    expect(result.facts).toEqual(["x"]);
  });

  it("falls back to raw text summary for pure prose", () => {
    const raw = "これはJSONではない普通の文章です。";
    const result = parsePitwallAnalysis(raw);
    expect(result.parseFallback).toBe(true);
    expect(result.statusSummary).toBe(raw);
    expect(result.facts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("null-fills missing fields via zod when JSON is partial", () => {
    const raw = JSON.stringify({ statusSummary: "s only" });
    const result = parsePitwallAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.statusSummary).toBe("s only");
    expect(result.change).toBe("");
    expect(result.question).toBe("");
    expect(result.proposal).toBe("");
    expect(result.confidence).toBeNull();
    expect(result.needsReview).toBe(false);
    expect(result.facts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects an invalid confidence enum value via the JSON fallback chain", () => {
    // "confidence": "urgent" isn't in the enum, so zod fails and it falls
    // through to the raw-text fallback rather than silently coercing it.
    const raw = JSON.stringify({ statusSummary: "s", confidence: "urgent" });
    const result = parsePitwallAnalysis(raw);
    expect(result.parseFallback).toBe(true);
  });
});

describe("parseDriverAnalysis", () => {
  it("parses a plain JSON object", () => {
    const raw = JSON.stringify({
      headline: "1周目走行中",
      action: "点検確認",
      watch: "エンジン音に注意",
      urgency: "medium",
    });
    const result = parseDriverAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.headline).toBe("1周目走行中");
    expect(result.action).toBe("点検確認");
    expect(result.watch).toBe("エンジン音に注意");
    expect(result.urgency).toBe("medium");
  });

  it("parses JSON wrapped in a code fence", () => {
    const raw = [
      "```json",
      JSON.stringify({
        headline: "h",
        action: "a",
        watch: null,
        urgency: "low",
      }),
      "```",
    ].join("\n");
    const result = parseDriverAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.headline).toBe("h");
  });

  it("extracts JSON preceded by prose", () => {
    const json = JSON.stringify({
      headline: "h",
      action: "a",
      watch: null,
      urgency: "low",
    });
    const raw = `以下が結果です。\n${json}\nご確認ください。`;
    const result = parseDriverAnalysis(raw);
    expect(result.parseFallback).toBe(false);
    expect(result.headline).toBe("h");
  });

  it("preserves watch: null rather than coercing to a string", () => {
    const raw = JSON.stringify({
      headline: "h",
      action: "a",
      watch: null,
      urgency: "low",
    });
    const result = parseDriverAnalysis(raw);
    expect(result.watch).toBeNull();
  });

  it("hard-truncates headline/action/watch to 16 characters", () => {
    const long = "あ".repeat(40);
    const raw = JSON.stringify({
      headline: long,
      action: long,
      watch: long,
      urgency: "low",
    });
    const result = parseDriverAnalysis(raw);
    expect(result.headline).toBe("あ".repeat(16));
    expect(result.action).toBe("あ".repeat(16));
    expect(result.watch).toBe("あ".repeat(16));
  });

  it("falls back to raw text for pure prose", () => {
    const raw = "これはJSONではない普通の文章です。";
    const result = parseDriverAnalysis(raw);
    expect(result.parseFallback).toBe(true);
    expect(result.action).toBe("");
    expect(result.watch).toBeNull();
  });
});
