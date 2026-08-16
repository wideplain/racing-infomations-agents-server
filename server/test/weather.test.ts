import { describe, it, expect } from "vitest";
import { JmaWeatherProvider } from "../src/weather/jmaProvider.js";

const AREA_JSON = {
  offices: {
    "430000": { name: "熊本県", parent: "" },
  },
  class10s: {
    "430010": { name: "熊本地方", parent: "430000" },
  },
  class15s: {
    "4310100": { name: "熊本地方15", parent: "430010" },
  },
  class20s: {
    "43100100": { name: "熊本市", parent: "4310100" },
  },
};

const FORECAST_JSON = [
  {
    timeSeries: [
      {
        areas: [
          {
            area: { code: "430010", name: "熊本地方" },
            weathers: ["くもり時々雨"],
          },
        ],
      },
      {
        areas: [
          {
            area: { code: "430010", name: "熊本地方" },
            pops: ["60"],
          },
        ],
      },
    ],
  },
];

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as Response;
}

function makeFetch(opts: {
  gsiMuniCd?: string;
  areaJson?: unknown;
  forecastJson?: unknown;
  fail?: "gsi" | "area" | "forecast";
}) {
  let calls = 0;
  const fn = async (url: string | URL, _init?: RequestInit) => {
    calls++;
    const u = url.toString();
    if (u.includes("mreversegeocoder")) {
      if (opts.fail === "gsi") throw new Error("network error");
      return jsonResponse({ results: { muniCd: opts.gsiMuniCd ?? "431001" } });
    }
    if (u.includes("area.json")) {
      if (opts.fail === "area") return jsonResponse({}, false);
      return jsonResponse(opts.areaJson ?? AREA_JSON);
    }
    if (u.includes("/forecast/data/forecast/")) {
      if (opts.fail === "forecast") throw new Error("network error");
      return jsonResponse(opts.forecastJson ?? FORECAST_JSON);
    }
    throw new Error(`unexpected url: ${u}`);
  };
  return { fn: fn as unknown as typeof fetch, getCalls: () => calls };
}

describe("JmaWeatherProvider", () => {
  it("resolves a weather summary in the normal case", async () => {
    const { fn } = makeFetch({ gsiMuniCd: "431001" });
    const provider = new JmaWeatherProvider({ fetchFn: fn, timeoutMs: 1000 });
    const result = await provider.getWeather(32.8, 130.7);
    expect(result).not.toBeNull();
    expect(result?.summaryText).toBe("熊本地方: くもり時々雨 / 降水確率: 60%");
    expect(result?.source).toBe("jma");
  });

  it("falls back to a class20 prefix match when the exact muniCd+00 key is missing", async () => {
    const areaJson = {
      ...AREA_JSON,
      class20s: {
        // no exact "43100100" key, but a prefix match for muniCd "431001"
        "43100199": { name: "熊本市中央区", parent: "4310100" },
      },
    };
    const { fn } = makeFetch({ gsiMuniCd: "431001", areaJson });
    const provider = new JmaWeatherProvider({ fetchFn: fn, timeoutMs: 1000 });
    const result = await provider.getWeather(32.8, 130.7);
    expect(result).not.toBeNull();
    expect(result?.summaryText).toBe("熊本地方: くもり時々雨 / 降水確率: 60%");
  });

  it("falls back to the city-level class20 code for seirei-city ward muniCds", async () => {
    // 実データ形: 熊本市中央区の muniCd は "43101"、class20s には市コード "4310000" のみ存在
    const areaJson = {
      ...AREA_JSON,
      class15s: { "4310000": { name: "熊本地方15", parent: "430010" } },
      class20s: { "4310000": { name: "熊本市", parent: "4310000" } },
    };
    const { fn } = makeFetch({ gsiMuniCd: "43101", areaJson });
    const provider = new JmaWeatherProvider({ fetchFn: fn, timeoutMs: 1000 });
    const result = await provider.getWeather(32.8, 130.7);
    expect(result).not.toBeNull();
    expect(result?.summaryText).toBe("熊本地方: くもり時々雨 / 降水確率: 60%");
  });

  it("returns null instead of throwing when a fetch stage fails", async () => {
    const { fn } = makeFetch({ fail: "forecast" });
    const provider = new JmaWeatherProvider({ fetchFn: fn, timeoutMs: 1000 });
    const result = await provider.getWeather(32.8, 130.7);
    expect(result).toBeNull();
  });

  it("returns null on GSI failure without throwing", async () => {
    const { fn } = makeFetch({ fail: "gsi" });
    const provider = new JmaWeatherProvider({ fetchFn: fn, timeoutMs: 1000 });
    await expect(provider.getWeather(32.8, 130.7)).resolves.toBeNull();
  });

  it("caches results so a second call for the same location does not refetch everything", async () => {
    const { fn, getCalls } = makeFetch({ gsiMuniCd: "431001" });
    const provider = new JmaWeatherProvider({ fetchFn: fn, timeoutMs: 1000 });
    await provider.getWeather(32.8, 130.7);
    const firstCallCount = getCalls();
    await provider.getWeather(32.8, 130.7);
    const secondCallCount = getCalls() - firstCallCount;
    expect(secondCallCount).toBeLessThan(firstCallCount);
  });
});
