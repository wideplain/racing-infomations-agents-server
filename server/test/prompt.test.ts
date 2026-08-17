import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  buildTranscript,
  buildPitwallPrompt,
  buildDriverPrompt,
  buildDecisions,
  buildQuestionPrompt,
  buildPriorRecords,
  transcriptStamps,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_MAX_CHARS,
  QUESTION_MAX_SEGMENTS,
  QUESTION_MAX_CHARS,
  type PromptSegment,
  type PitwallDecision,
  type PriorRecord,
} from "../src/analysis/prompt.js";

const baseTime = new Date("2026-08-16T00:00:00.000Z");

function makeSegments(n: number): PromptSegment[] {
  const segs: PromptSegment[] = [];
  for (let i = 0; i < n; i++) {
    segs.push({
      clientSeq: i,
      text: `発言${i}`,
      createdAt: new Date(baseTime.getTime() + i * 1000).toISOString(),
    });
  }
  return segs;
}

describe("buildTranscript", () => {
  it("formats [mm:ss] prefixed lines relative to session start", () => {
    const segs = makeSegments(3);
    const out = buildTranscript(segs, baseTime.toISOString());
    expect(out).toBe("[00:00] 発言0\n[00:01] 発言1\n[00:02] 発言2");
  });

  it("keeps only the last maxSegments entries", () => {
    const segs = makeSegments(50);
    const out = buildTranscript(segs, baseTime.toISOString(), 10);
    const lines = out.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain("発言40");
    expect(lines[9]).toContain("発言49");
  });

  it("trims from the front to respect a character budget", () => {
    const segs: PromptSegment[] = [];
    for (let i = 0; i < 20; i++) {
      segs.push({
        clientSeq: i,
        text: "あ".repeat(100),
        createdAt: new Date(baseTime.getTime() + i * 1000).toISOString(),
      });
    }
    const out = buildTranscript(segs, baseTime.toISOString(), 40, 500);
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe("buildPrompt", () => {
  it("embeds the transcript into the {{TRANSCRIPT}} placeholder", () => {
    const segs = makeSegments(2);
    const prompt = buildPrompt(segs, baseTime.toISOString(), {
      template: "HEADER\n{{TRANSCRIPT}}\nFOOTER",
    });
    expect(prompt).toContain("HEADER");
    expect(prompt).toContain("FOOTER");
    expect(prompt).toContain("[00:00] 発言0");
    expect(prompt).toContain("[00:01] 発言1");
  });

  it("loads the real prompt template file when none is given and contains SUMMARY instructions", () => {
    const segs = makeSegments(1);
    const prompt = buildPrompt(segs, baseTime.toISOString());
    expect(prompt).toContain("summary");
    expect(prompt).toContain("[00:00] 発言0");
  });
});

describe("buildDecisions", () => {
  it("returns なし when there are no prior decisions", () => {
    expect(buildDecisions([])).toBe("なし");
  });

  it("formats prior decisions as [HH:mm] 提案: ... / 状況: ... lines", () => {
    const decisions: PitwallDecision[] = [
      {
        createdAt: "2026-08-16T01:02:00.000Z",
        proposal: "ピットインを検討",
        statusSummary: "順調に走行中",
      },
    ];
    const out = buildDecisions(decisions);
    expect(out).toContain("提案: ピットインを検討");
    expect(out).toContain("状況: 順調に走行中");
    expect(out).toMatch(/^\[\d{2}:\d{2}\]/);
  });
});

describe("buildPitwallPrompt", () => {
  it("embeds transcript and DECISIONS placeholders", () => {
    const segs = makeSegments(1);
    const decisions: PitwallDecision[] = [
      {
        createdAt: baseTime.toISOString(),
        proposal: "提案テスト",
        statusSummary: "状況テスト",
      },
    ];
    const prompt = buildPitwallPrompt(segs, baseTime.toISOString(), decisions, {
      template: "HEADER\n{{TRANSCRIPT}}\n---\n{{DECISIONS}}\nFOOTER",
    });
    expect(prompt).toContain("[00:00] 発言0");
    expect(prompt).toContain("提案: 提案テスト");
    expect(prompt).toContain("状況: 状況テスト");
  });

  it("fills {{DECISIONS}} with なし when there are no prior analyses", () => {
    const segs = makeSegments(1);
    const prompt = buildPitwallPrompt(segs, baseTime.toISOString(), [], {
      template: "{{TRANSCRIPT}}\n{{DECISIONS}}",
    });
    expect(prompt).toContain("なし");
  });

  it("loads the real pitwall prompt template file when none is given", () => {
    const segs = makeSegments(1);
    const prompt = buildPitwallPrompt(segs, baseTime.toISOString(), []);
    expect(prompt).toContain("statusSummary");
    expect(prompt).toContain("[00:00] 発言0");
    expect(prompt).toContain("なし");
  });
});

describe("buildDriverPrompt", () => {
  it("embeds transcript and DECISIONS placeholders", () => {
    const segs = makeSegments(1);
    const decisions: PitwallDecision[] = [
      {
        createdAt: baseTime.toISOString(),
        proposal: "提案テスト",
        statusSummary: "状況テスト",
      },
    ];
    const prompt = buildDriverPrompt(segs, baseTime.toISOString(), decisions, {
      template: "HEADER\n{{TRANSCRIPT}}\n---\n{{DECISIONS}}\nFOOTER",
    });
    expect(prompt).toContain("[00:00] 発言0");
    expect(prompt).toContain("提案: 提案テスト");
    expect(prompt).toContain("状況: 状況テスト");
  });

  it("fills {{DECISIONS}} and {{INSTRUCTION}} with なし when empty", () => {
    const segs = makeSegments(1);
    const prompt = buildDriverPrompt(segs, baseTime.toISOString(), [], {
      template: "{{TRANSCRIPT}}\n{{DECISIONS}}\n{{INSTRUCTION}}",
    });
    const lines = prompt.split("\n");
    expect(lines[1]).toBe("なし");
    expect(lines[2]).toBe("なし");
  });

  it("loads the real driver prompt template file when none is given", () => {
    const segs = makeSegments(1);
    const prompt = buildDriverPrompt(segs, baseTime.toISOString(), []);
    expect(prompt).toContain("headline");
    expect(prompt).toContain("[00:00] 発言0");
    expect(prompt).toContain("なし");
    expect(prompt).toContain("{{WEATHER}}");
  });
});

describe("buildPriorRecords", () => {
  it("returns なし when there are no prior records", () => {
    expect(buildPriorRecords([])).toBe("なし");
  });

  it("formats prior records as (ラベル hh:mm) 本文 lines", () => {
    const records: PriorRecord[] = [
      {
        createdAt: "2026-08-16T01:02:00.000Z",
        label: "ピットウォール",
        text: "状況: 順調 / 提案: ピットインを検討",
      },
    ];
    const out = buildPriorRecords(records);
    expect(out).toMatch(/^\(ピットウォール \d{2}:\d{2}\) 状況: 順調 \/ 提案: ピットインを検討$/);
  });

  it("never starts a line with a bracketed stamp, which would read as a transcript position", () => {
    // transcriptStamps() anchors on line-leading brackets, and the model is told a bracketed
    // stamp is an elapsed transcript position. A record's wall clock must not look like one.
    const out = buildPriorRecords([
      { createdAt: "2026-08-16T01:02:00.000Z", label: "質問", text: "Q: 燃料は？ / A: 5周分" },
    ]);
    expect(out).not.toMatch(/^\[/m);
    expect(transcriptStamps(out).size).toBe(0);
  });
});

describe("transcriptStamps", () => {
  it("collects the bracketed elapsed stamps of a built question prompt's transcript", () => {
    const prompt = buildQuestionPrompt(makeSegments(3), baseTime.toISOString(), [], {
      template: "{{TRANSCRIPT}}\n{{DECISIONS}}\n{{QUESTION}}",
      question: "q",
    });
    expect(transcriptStamps(prompt)).toEqual(new Set(["00:00", "00:01", "00:02"]));
  });

  it("ignores a bracketed stamp that is not at the start of a line", () => {
    expect(transcriptStamps("答えは [12:34] のあたりです")).toEqual(new Set());
  });
});

describe("buildQuestionPrompt", () => {
  it("substitutes {{TRANSCRIPT}}, {{DECISIONS}} and {{QUESTION}}", () => {
    const segs = makeSegments(1);
    const records: PriorRecord[] = [
      { createdAt: baseTime.toISOString(), label: "質問", text: "Q: 燃料は？ / A: 5周分" },
    ];
    const prompt = buildQuestionPrompt(segs, baseTime.toISOString(), records, {
      template: "HEADER\n{{TRANSCRIPT}}\n---\n{{DECISIONS}}\n---\n{{QUESTION}}\nFOOTER",
      question: "タイヤは何周目に交換した？",
    });
    expect(prompt).toContain("[00:00] 発言0");
    expect(prompt).toMatch(/\(質問 \d{2}:\d{2}\) Q: 燃料は？ \/ A: 5周分/);
    expect(prompt).toContain("タイヤは何周目に交換した？");
  });

  it("defaults to QUESTION_MAX_SEGMENTS, keeping lines the 40-segment default would drop", () => {
    const segs = makeSegments(50);
    const prompt = buildQuestionPrompt(segs, baseTime.toISOString(), [], {
      template: "{{TRANSCRIPT}}\n{{DECISIONS}}\n{{QUESTION}}",
      question: "q",
    });
    // With the default 40-segment window this would have scrolled out; question mode's
    // wider window must still surface it.
    expect(prompt).toContain("発言0\n");
  });

  it("QUESTION_MAX_SEGMENTS and QUESTION_MAX_CHARS are wider than the reporting-mode defaults", () => {
    expect(QUESTION_MAX_SEGMENTS).toBeGreaterThan(DEFAULT_MAX_SEGMENTS);
    expect(QUESTION_MAX_CHARS).toBeGreaterThan(DEFAULT_MAX_CHARS);
  });

  it("says so when the window dropped older lines, instead of presenting an excerpt as complete", () => {
    const prompt = buildQuestionPrompt(makeSegments(10), baseTime.toISOString(), [], {
      template: "{{TRANSCRIPT}}\n{{DECISIONS}}\n{{QUESTION}}",
      question: "q",
      maxSegments: 3,
    });
    expect(prompt).toContain("これ以前の発言はこのプロンプトに含まれていません");
    expect(prompt).toContain("発言9");
    expect(prompt).not.toContain("発言6");
  });

  it("adds no truncation notice when the whole conversation fits", () => {
    const prompt = buildQuestionPrompt(makeSegments(3), baseTime.toISOString(), [], {
      template: "{{TRANSCRIPT}}\n{{DECISIONS}}\n{{QUESTION}}",
      question: "q",
    });
    expect(prompt).not.toContain("これ以前の発言");
  });
});
