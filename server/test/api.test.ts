import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { AIProvider, AnalyzeInput, AnalyzeOutput } from "../src/ai/types.js";

const config: Config = {
  port: 0,
  host: "127.0.0.1",
  apiKey: "test-key",
  dbPath: ":memory:",
  aiProvider: "codex",
  codexBin: "codex",
  analyzeTimeoutMs: 1000,
  codexHome: undefined,
};

class FakeProvider implements AIProvider {
  name = "codex";
  async analyze(input: AnalyzeInput): Promise<AnalyzeOutput> {
    if (input.schemaPath && input.schemaPath.endsWith("pitwall.schema.json")) {
      return {
        summary: "",
        interpretation: "",
        advice: [],
        suggested_response: "",
        confidence: null,
        notes: null,
        parseFallback: false,
        rawOutput: JSON.stringify({
          statusSummary: "1周目、順調に走行中。",
          change: "特になし。",
          question: "燃料残量は確認済みですか？",
          proposal: "次のピットで確認してはどうでしょうか。",
          confidence: "medium",
          needsReview: true,
          facts: ["1周目を走行中"],
          warnings: ["燃料量は聞き取れませんでした"],
        }),
        durationMs: 5,
      };
    }
    return {
      summary: "要約",
      interpretation: "解釈",
      advice: ["アドバイス"],
      suggested_response: "返答",
      confidence: 0.9,
      notes: null,
      parseFallback: false,
      rawOutput: "{}",
      durationMs: 5,
    };
  }
  async healthcheck(): Promise<boolean> {
    return true;
  }
}

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(":memory:");
  app = await buildApp({ db, config, provider: new FakeProvider() });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

function authHeaders() {
  return { "x-api-key": "test-key" };
}

describe("API", () => {
  it("rejects requests without X-Api-Key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a session, posts segments idempotently, and lists them in order", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: { title: "テスト" },
    });
    expect(createRes.statusCode).toBe(201);
    const session = createRes.json();

    const postSegments = (segments: unknown[]) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/segments`,
        headers: authHeaders(),
        payload: { segments },
      });

    const first = await postSegments([
      { clientSeq: 1, text: "こんにちは" },
      { clientSeq: 2, text: "元気ですか" },
    ]);
    expect(first.statusCode).toBe(201);
    expect(first.json().inserted).toBe(2);

    // Resend with an overlapping clientSeq: should be a no-op for seq=2.
    const resend = await postSegments([
      { clientSeq: 2, text: "元気ですか" },
      { clientSeq: 3, text: "さようなら" },
    ]);
    expect(resend.statusCode).toBe(201);
    expect(resend.json().inserted).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
      headers: authHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.segments).toHaveLength(3);
    expect(body.segments.map((s: { text: string }) => s.text)).toEqual([
      "こんにちは",
      "元気ですか",
      "さようなら",
    ]);
  });

  it("runs analyze end-to-end and polling reaches done", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: {},
    });
    const session = createRes.json();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/segments`,
      headers: authHeaders(),
      payload: { segments: [{ clientSeq: 1, text: "テスト発話" }] },
    });

    const analyzeRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/analyze`,
      headers: authHeaders(),
    });
    expect(analyzeRes.statusCode).toBe(202);
    const { analysisId } = analyzeRes.json();

    let status = "";
    let body: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const pollRes = await app.inject({
        method: "GET",
        url: `/api/analyses/${analysisId}`,
        headers: authHeaders(),
      });
      body = pollRes.json();
      status = body.status as string;
      if (status === "done" || status === "error") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(status).toBe("done");
    expect((body.result as { summary: string }).summary).toBe("要約");
  });

  it("runs a pitwall-mode analyze end-to-end and persists mode + parsed result", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: {},
    });
    const session = createRes.json();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/segments`,
      headers: authHeaders(),
      payload: { segments: [{ clientSeq: 1, text: "1周目通過" }] },
    });

    const analyzeRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/analyze`,
      headers: authHeaders(),
      payload: { mode: "pitwall" },
    });
    expect(analyzeRes.statusCode).toBe(202);
    const { analysisId } = analyzeRes.json();

    let status = "";
    let body: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const pollRes = await app.inject({
        method: "GET",
        url: `/api/analyses/${analysisId}`,
        headers: authHeaders(),
      });
      body = pollRes.json();
      status = body.status as string;
      if (status === "done" || status === "error") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(status).toBe("done");
    expect(body.mode).toBe("pitwall");
    const result = body.result as Record<string, unknown>;
    expect(result.statusSummary).toBe("1周目、順調に走行中。");
    expect(result.proposal).toBe("次のピットで確認してはどうでしょうか。");
    expect(result.confidence).toBe("medium");
    expect(result.needsReview).toBe(true);
  });

  it("rejects an unknown analyze mode", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: {},
    });
    const session = createRes.json();

    const analyzeRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/analyze`,
      headers: authHeaders(),
      payload: { mode: "bogus" },
    });
    expect(analyzeRes.statusCode).toBe(400);
  });
});
