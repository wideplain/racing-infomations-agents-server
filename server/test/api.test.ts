import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { AIProvider, AnalyzeInput, AnalyzeOutput } from "../src/ai/types.js";
import type { WeatherInfo, WeatherProvider } from "../src/weather/types.js";
import { RouteResolver } from "../src/route/routeResolver.js";

const config: Config = {
  port: 0,
  host: "127.0.0.1",
  apiKey: "test-key",
  dbPath: ":memory:",
  aiProvider: "codex",
  codexBin: "codex",
  analyzeTimeoutMs: 1000,
  codexHome: undefined,
  weatherEnabled: true,
  weatherTimeoutMs: 1000,
};

class FakeWeatherProvider implements WeatherProvider {
  result: WeatherInfo | null = null;
  async getWeather(): Promise<WeatherInfo | null> {
    return this.result;
  }
}

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
    if (input.schemaPath && input.schemaPath.endsWith("driver.schema.json")) {
      return {
        summary: "",
        interpretation: "",
        advice: [],
        suggested_response: "",
        confidence: null,
        notes: null,
        parseFallback: false,
        rawOutput: JSON.stringify({
          headline: "1周目を走行中",
          action: "点検のタイミングを確認",
          watch: null,
          urgency: "low",
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
let fakeWeather: FakeWeatherProvider;

beforeEach(async () => {
  db = openDb(":memory:");
  fakeWeather = new FakeWeatherProvider();
  app = await buildApp({ db, config, provider: new FakeProvider(), weather: fakeWeather });
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

  it("runs a driver-mode analyze end-to-end and persists mode + parsed result", async () => {
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
      payload: { mode: "driver" },
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
    expect(body.mode).toBe("driver");
    const result = body.result as Record<string, unknown>;
    expect(result.headline).toBe("1周目を走行中");
    expect(result.action).toBe("点検のタイミングを確認");
    expect(result.watch).toBeNull();
    expect(result.urgency).toBe("low");
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

  it("injects weather summary into the persisted driver prompt when location is given", async () => {
    fakeWeather.result = {
      summaryText: "熊本地方: くもり時々雨 / 降水確率: 60%",
      fetchedAt: new Date().toISOString(),
      source: "jma",
    };

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
      payload: { mode: "driver", location: { lat: 32.8, lng: 130.7 } },
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
    expect(body.prompt as string).toContain("熊本地方: くもり時々雨 / 降水確率: 60%");
  });

  it("falls back to the no-weather placeholder when the weather provider returns null", async () => {
    fakeWeather.result = null;

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
      payload: { mode: "driver", location: { lat: 32.8, lng: 130.7 } },
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
    expect(body.prompt as string).toContain("(天気情報なし)");
  });

  it("falls back to the latest posted location for driver weather when the request has none", async () => {
    fakeWeather.result = {
      summaryText: "熊本地方: 晴れ / 降水確率: 10%",
      fetchedAt: new Date().toISOString(),
      source: "jma",
    };

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

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
      payload: {
        locations: [
          {
            lat: 32.8,
            lng: 130.7,
            recordedAt: new Date().toISOString(),
          },
        ],
      },
    });

    const analyzeRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/analyze`,
      headers: authHeaders(),
      payload: { mode: "driver" },
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
    expect(body.prompt as string).toContain("熊本地方: 晴れ / 降水確率: 10%");
  });

  it("does not fall back to a stale posted location for driver weather", async () => {
    fakeWeather.result = {
      summaryText: "熊本地方: 晴れ / 降水確率: 10%",
      fetchedAt: new Date().toISOString(),
      source: "jma",
    };

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

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
      payload: {
        locations: [
          {
            lat: 32.8,
            lng: 130.7,
            recordedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    });

    const analyzeRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/analyze`,
      headers: authHeaders(),
      payload: { mode: "driver" },
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
    expect(body.prompt as string).toContain("(天気情報なし)");
  });

  it("rejects an invalid location", async () => {
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
      payload: { mode: "driver", location: { lat: 999, lng: 0 } },
    });
    expect(analyzeRes.statusCode).toBe(400);
    expect(analyzeRes.json()).toEqual({ error: "invalid_location" });
  });

  it("rejects requests to locations without X-Api-Key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/some-id/locations",
    });
    expect(res.statusCode).toBe(401);
  });

  it("posts locations and lists them back with matching values", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: {},
    });
    const session = createRes.json();

    const postRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
      payload: {
        locations: [
          {
            lat: 35.681236,
            lng: 139.767125,
            accuracyM: 5.5,
            speedMps: 12.3,
            bearingDeg: 90,
            recordedAt: "2026-08-16T00:00:00.000Z",
          },
        ],
      },
    });
    expect(postRes.statusCode).toBe(201);
    expect(postRes.json()).toEqual({ inserted: 1 });

    const listRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
    });
    expect(listRes.statusCode).toBe(200);
    const { locations } = listRes.json();
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      session_id: session.id,
      lat: 35.681236,
      lng: 139.767125,
      accuracy_m: 5.5,
      speed_mps: 12.3,
      bearing_deg: 90,
      recorded_at: "2026-08-16T00:00:00.000Z",
    });
  });

  it("rejects invalid location payloads", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: {},
    });
    const session = createRes.json();

    const badLat = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
      payload: {
        locations: [{ lat: 91, lng: 0, recordedAt: "2026-08-16T00:00:00.000Z" }],
      },
    });
    expect(badLat.statusCode).toBe(400);

    const badLng = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
      payload: {
        locations: [{ lat: 0, lng: 181, recordedAt: "2026-08-16T00:00:00.000Z" }],
      },
    });
    expect(badLng.statusCode).toBe(400);

    const empty = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
      payload: { locations: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("returns 404 for locations on an unknown session", async () => {
    const postRes = await app.inject({
      method: "POST",
      url: "/api/sessions/does-not-exist/locations",
      headers: authHeaders(),
      payload: {
        locations: [{ lat: 0, lng: 0, recordedAt: "2026-08-16T00:00:00.000Z" }],
      },
    });
    expect(postRes.statusCode).toBe(404);

    const getRes = await app.inject({
      method: "GET",
      url: "/api/sessions/does-not-exist/locations",
      headers: authHeaders(),
    });
    expect(getRes.statusCode).toBe(404);
  });

  it("returns only locations after the given id for incremental polling", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: {},
    });
    const session = createRes.json();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
      payload: {
        locations: [
          { lat: 1, lng: 1, recordedAt: "2026-08-16T00:00:00.000Z" },
          { lat: 2, lng: 2, recordedAt: "2026-08-16T00:00:01.000Z" },
          { lat: 3, lng: 3, recordedAt: "2026-08-16T00:00:02.000Z" },
        ],
      },
    });

    const firstList = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
    });
    const all = firstList.json().locations as { id: number }[];
    expect(all).toHaveLength(3);
    const afterId = all[0].id;

    const incremental = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/locations?after=${afterId}`,
      headers: authHeaders(),
    });
    const { locations } = incremental.json();
    expect(locations).toHaveLength(2);
    expect(locations.map((l: { lat: number }) => l.lat)).toEqual([2, 3]);
  });

  it("returns the resolved, geocoded route for a session's locations", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: authHeaders(),
      payload: {},
    });
    const session = createRes.json();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/locations`,
      headers: authHeaders(),
      payload: {
        locations: [
          { lat: 32.8, lng: 130.7, recordedAt: "2026-08-16T00:00:00.000Z" },
          { lat: 32.9, lng: 130.7, recordedAt: "2026-08-16T00:10:00.000Z" },
        ],
      },
    });

    const fakeFetch = (async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("mreversegeocoder")) {
        const lat = Number(new URL(u).searchParams.get("lat"));
        const muniCd = lat < 32.85 ? "43100" : "43201";
        return { ok: true, json: async () => ({ results: { muniCd, lv01Nm: "" } }) } as Response;
      }
      if (u.includes("muni.js")) {
        return {
          ok: true,
          text: async () =>
            'GSI.MUNI_ARRAY["43100"]="43,熊本県,43100,熊本市";\n' +
            'GSI.MUNI_ARRAY["43201"]="43,熊本県,43201,八代市";',
        } as Response;
      }
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;

    const routeApp = await buildApp({
      db,
      config,
      provider: new FakeProvider(),
      weather: fakeWeather,
      routeResolver: new RouteResolver({ fetchFn: fakeFetch, timeoutMs: 1000 }),
    });
    await routeApp.ready();
    try {
      const routeRes = await routeApp.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/route`,
        headers: authHeaders(),
      });
      expect(routeRes.statusCode).toBe(200);
      const body = routeRes.json();
      expect(body.pointCount).toBe(2);
      expect(body.route).toHaveLength(2);
      expect(body.route[0].name).toBe("熊本県熊本市");
      expect(body.route[1].name).toBe("熊本県八代市");
    } finally {
      await routeApp.close();
    }
  });

  it("returns 404 for route on an unknown session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/does-not-exist/route",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});
