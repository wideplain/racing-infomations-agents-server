import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  buildTranscript,
  buildPitwallPrompt,
  buildDriverPrompt,
  buildDecisions,
  type PromptSegment,
  type PitwallDecision,
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
