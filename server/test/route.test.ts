import { describe, it, expect } from "vitest";
import { RouteResolver } from "../src/route/routeResolver.js";
import type { LocationRow } from "../src/db/repo.js";

const MUNI_JS = `
var GSI = GSI || {};
GSI.MUNI_ARRAY = GSI.MUNI_ARRAY || {};
GSI.MUNI_ARRAY["43100"]="43,熊本県,43100,熊本市";
GSI.MUNI_ARRAY["43201"]="43,熊本県,43201,八代市";
`;

function loc(
  id: number,
  lat: number,
  lng: number,
  recordedAt: string
): LocationRow {
  return {
    id,
    session_id: "s1",
    lat,
    lng,
    accuracy_m: null,
    speed_mps: null,
    bearing_deg: null,
    recorded_at: recordedAt,
    created_at: recordedAt,
  };
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function textResponse(body: string, ok = true) {
  return { ok, text: async () => body } as Response;
}

/** Builds a fake fetch: geocode results keyed by "lat,lng" (rounded to 3 decimals, matching the
 * resolver's cache key), and a fixed muni.js body. Records every call url for assertions. */
function makeFetch(opts: {
  geocodeByKey?: Record<string, { muniCd: string; lv01Nm?: string } | "fail" | "miss">;
  muniJs?: string | "fail";
}) {
  const calls: string[] = [];
  const fn = async (url: string | URL) => {
    const u = url.toString();
    calls.push(u);
    if (u.includes("mreversegeocoder")) {
      const params = new URL(u).searchParams;
      const lat = Number(params.get("lat")).toFixed(3);
      const lon = Number(params.get("lon")).toFixed(3);
      const key = `${lat},${lon}`;
      const entry = opts.geocodeByKey?.[key];
      if (entry === "fail") throw new Error("network error");
      if (entry === "miss" || entry === undefined) return jsonResponse({ results: {} });
      return jsonResponse({ results: entry });
    }
    if (u.includes("muni.js")) {
      if (opts.muniJs === "fail") return textResponse("", false);
      return textResponse(opts.muniJs ?? MUNI_JS);
    }
    throw new Error(`unexpected url: ${u}`);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("RouteResolver", () => {
  it("resolves consecutive same-name points into a single collapsed entry with enteredAt", async () => {
    // Points spaced ~1km apart so none get distance-filtered out.
    const points = [
      loc(1, 32.80, 130.70, "2026-08-16T00:00:00.000Z"),
      loc(2, 32.81, 130.70, "2026-08-16T00:05:00.000Z"), // still 熊本市
      loc(3, 32.90, 130.70, "2026-08-16T00:10:00.000Z"), // moves to 八代市
    ];
    const { fn } = makeFetch({
      geocodeByKey: {
        "32.800,130.700": { muniCd: "43100", lv01Nm: "" },
        "32.810,130.700": { muniCd: "43100", lv01Nm: "" },
        "32.900,130.700": { muniCd: "43201", lv01Nm: "" },
      },
    });
    const resolver = new RouteResolver({ fetchFn: fn, timeoutMs: 1000 });
    const route = await resolver.resolveRoute(points);

    expect(route).toHaveLength(2);
    expect(route[0]).toMatchObject({
      name: "熊本県熊本市",
      muniCd: "43100",
      enteredAt: "2026-08-16T00:00:00.000Z",
    });
    expect(route[1]).toMatchObject({
      name: "熊本県八代市",
      muniCd: "43201",
      enteredAt: "2026-08-16T00:10:00.000Z",
    });
  });

  it("skips consecutive points closer than ~300m before geocoding", async () => {
    // ~1m apart (well under 300m) — should collapse to just the first point pre-geocode.
    const points = [
      loc(1, 32.80000, 130.70000, "2026-08-16T00:00:00.000Z"),
      loc(2, 32.80001, 130.70000, "2026-08-16T00:00:01.000Z"),
      loc(3, 32.80002, 130.70000, "2026-08-16T00:00:02.000Z"),
    ];
    const { fn, calls } = makeFetch({
      geocodeByKey: {
        "32.800,130.700": { muniCd: "43100", lv01Nm: "" },
      },
    });
    const resolver = new RouteResolver({ fetchFn: fn, timeoutMs: 1000 });
    const route = await resolver.resolveRoute(points);

    expect(route).toHaveLength(1);
    const geocodeCalls = calls.filter((u) => u.includes("mreversegeocoder"));
    expect(geocodeCalls).toHaveLength(1);
  });

  it("caps geocode calls at 30 via even spacing when far more sample points remain", async () => {
    // 100 points, each ~1km apart (well over the 300m threshold), so all 100 survive the
    // distance filter and must be capped down to 30 geocode calls.
    const points: LocationRow[] = [];
    for (let i = 0; i < 100; i++) {
      points.push(loc(i + 1, 32.0 + i * 0.01, 130.0, `2026-08-16T00:${String(i).padStart(2, "0")}:00.000Z`));
    }
    let geocodeCallCount = 0;
    const fn = (async (url: string | URL) => {
      const u = url.toString();
      if (u.includes("mreversegeocoder")) {
        geocodeCallCount++;
        return jsonResponse({ results: { muniCd: "43100", lv01Nm: "" } });
      }
      if (u.includes("muni.js")) return textResponse(MUNI_JS);
      throw new Error(`unexpected url: ${u}`);
    }) as unknown as typeof fetch;

    const resolver = new RouteResolver({ fetchFn: fn, timeoutMs: 1000 });
    await resolver.resolveRoute(points);
    expect(geocodeCallCount).toBeLessThanOrEqual(30);
  });

  it("skips points whose geocode call fails or returns no muniCd", async () => {
    const points = [
      loc(1, 32.80, 130.70, "2026-08-16T00:00:00.000Z"),
      loc(2, 32.81, 130.70, "2026-08-16T00:05:00.000Z"),
      loc(3, 32.82, 130.70, "2026-08-16T00:10:00.000Z"),
    ];
    const { fn } = makeFetch({
      geocodeByKey: {
        "32.800,130.700": { muniCd: "43100", lv01Nm: "" },
        "32.810,130.700": "fail",
        "32.820,130.700": "miss",
      },
    });
    const resolver = new RouteResolver({ fetchFn: fn, timeoutMs: 1000 });
    const route = await resolver.resolveRoute(points);

    expect(route).toHaveLength(1);
    expect(route[0].muniCd).toBe("43100");
  });

  it("returns an empty array without throwing when every point fails to geocode", async () => {
    const points = [loc(1, 32.80, 130.70, "2026-08-16T00:00:00.000Z")];
    const { fn } = makeFetch({ geocodeByKey: { "32.800,130.700": "fail" } });
    const resolver = new RouteResolver({ fetchFn: fn, timeoutMs: 1000 });
    await expect(resolver.resolveRoute(points)).resolves.toEqual([]);
  });

  it("falls back to muniCd as the name when muni.js fails to load/parse", async () => {
    const points = [loc(1, 32.80, 130.70, "2026-08-16T00:00:00.000Z")];
    const { fn } = makeFetch({
      geocodeByKey: { "32.800,130.700": { muniCd: "43100", lv01Nm: "" } },
      muniJs: "fail",
    });
    const resolver = new RouteResolver({ fetchFn: fn, timeoutMs: 1000 });
    const route = await resolver.resolveRoute(points);

    expect(route).toHaveLength(1);
    expect(route[0].name).toBe("43100");
    expect(route[0].muniCd).toBe("43100");
  });

  it("returns an empty array for an empty input", async () => {
    const { fn } = makeFetch({});
    const resolver = new RouteResolver({ fetchFn: fn, timeoutMs: 1000 });
    await expect(resolver.resolveRoute([])).resolves.toEqual([]);
  });
});
