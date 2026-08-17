import { describe, it, expect } from "vitest";
import {
  parseAnalysis,
  parsePitwallAnalysis,
  parseDriverAnalysis,
  parseQuestionAnalysis,
} from "../src/analysis/parse.js";

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

describe("parseQuestionAnalysis", () => {
  const sessionStartedAt = "2026-08-16T00:00:00.000Z";
  // The stamps the prompt actually showed the model. A citation outside this set stays
  // unresolved rather than being turned into an exact-looking time nobody can look up.
  const stamps = new Set(["12:34", "90:00", "05:07"]);

  // Mirrors the parser's own local-getter formatting so the expectation isn't hand-derived
  // from a Z-suffixed input, which would be wrong on any non-UTC machine.
  function localHms(d: Date): string {
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    const ss = d.getSeconds().toString().padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  it("parses a plain JSON object into answer/basedOn/confidence/unknown", () => {
    const raw = JSON.stringify({
      answer: "燃料はあと5周分です。",
      basedOn: [{ at: "12:34", quote: "燃料はあと5周分" }],
      confidence: "high",
      unknown: [],
    });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    expect(result.parseFallback).toBe(false);
    expect(result.answer).toBe("燃料はあと5周分です。");
    expect(result.basedOn).toHaveLength(1);
    expect(result.basedOn[0].quote).toBe("燃料はあと5周分");
    expect(result.confidence).toBe("high");
    expect(result.unknown).toEqual([]);
  });

  it("resolves basedOn[].at into a wall-clock HH:MM:SS in [clock]", () => {
    const raw = JSON.stringify({
      answer: "a",
      basedOn: [{ at: "12:34", quote: "q" }],
      confidence: "medium",
      unknown: [],
    });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    const expected = localHms(
      new Date(new Date(sessionStartedAt).getTime() + (12 * 60 + 34) * 1000)
    );
    expect(result.basedOn[0].clock).toBe(expected);
  });

  it("leaves clock null for an unparseable at while keeping at and quote intact", () => {
    const raw = JSON.stringify({
      answer: "a",
      basedOn: [
        { at: "あとで", quote: "q1" },
        { at: "12", quote: "q2" },
      ],
      confidence: "low",
      unknown: [],
    });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    expect(result.basedOn[0].at).toBe("あとで");
    expect(result.basedOn[0].clock).toBeNull();
    expect(result.basedOn[0].quote).toBe("q1");
    expect(result.basedOn[1].at).toBe("12");
    expect(result.basedOn[1].clock).toBeNull();
    expect(result.basedOn[1].quote).toBe("q2");
  });

  it("resolves an at wrapped in brackets", () => {
    const raw = JSON.stringify({
      answer: "a",
      basedOn: [{ at: "[12:34]", quote: "q" }],
      confidence: "medium",
      unknown: [],
    });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    const expected = localHms(
      new Date(new Date(sessionStartedAt).getTime() + (12 * 60 + 34) * 1000)
    );
    expect(result.basedOn[0].clock).toBe(expected);
  });

  it("resolves elapsed minutes past 60", () => {
    const raw = JSON.stringify({
      answer: "a",
      basedOn: [{ at: "90:00", quote: "q" }],
      confidence: "medium",
      unknown: [],
    });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    const expected = localHms(
      new Date(new Date(sessionStartedAt).getTime() + 90 * 60 * 1000)
    );
    expect(result.basedOn[0].clock).toBe(expected);
  });

  it("leaves clock null for a well-formed at that no transcript line carries", () => {
    const raw = JSON.stringify({
      answer: "a",
      basedOn: [{ at: "07:15", quote: "誰も言っていない台詞" }],
      confidence: "high",
      unknown: [],
    });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    expect(result.basedOn[0].at).toBe("07:15");
    expect(result.basedOn[0].clock).toBeNull();
    expect(result.basedOn[0].quote).toBe("誰も言っていない台詞");
  });

  it("leaves clock null for a wall-clock time copied out of the prior-records block", () => {
    // A record line reads "(ピットウォール 13:47) ...". Resolving that as elapsed would produce a
    // precise time pointing at an unrelated part of the log — the failure basedOn exists to stop.
    const raw = JSON.stringify({
      answer: "a",
      basedOn: [{ at: "13:47", quote: "次のピットで確認してはどうでしょうか。" }],
      confidence: "high",
      unknown: [],
    });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    expect(result.basedOn[0].clock).toBeNull();
  });

  it("accepts an at whose minutes lack the transcript's zero padding", () => {
    const raw = JSON.stringify({
      answer: "a",
      basedOn: [{ at: "5:07", quote: "q" }],
      confidence: "medium",
      unknown: [],
    });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    const expected = localHms(
      new Date(new Date(sessionStartedAt).getTime() + (5 * 60 + 7) * 1000)
    );
    expect(result.basedOn[0].clock).toBe(expected);
  });

  it("parses JSON wrapped in a code fence", () => {
    const raw = [
      "```json",
      JSON.stringify({
        answer: "a",
        basedOn: [],
        confidence: "low",
        unknown: ["記録にありません"],
      }),
      "```",
    ].join("\n");
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    expect(result.parseFallback).toBe(false);
    expect(result.answer).toBe("a");
    expect(result.unknown).toEqual(["記録にありません"]);
  });

  it("falls back to raw text for pure prose", () => {
    const raw = "これはJSONではない普通の文章です。";
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    expect(result.parseFallback).toBe(true);
    expect(result.answer).toBe(raw);
    expect(result.basedOn).toEqual([]);
  });

  it("null-fills missing/null optional fields to empty array / null rather than throwing", () => {
    const raw = JSON.stringify({ answer: "a", basedOn: null, confidence: null, unknown: null });
    const result = parseQuestionAnalysis(raw, sessionStartedAt, stamps);
    expect(result.parseFallback).toBe(false);
    expect(result.answer).toBe("a");
    expect(result.basedOn).toEqual([]);
    expect(result.confidence).toBeNull();
    expect(result.unknown).toEqual([]);
  });
});
