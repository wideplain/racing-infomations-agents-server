import { TtlCache } from "./cache.js";
import type { WeatherInfo, WeatherProvider } from "./types.js";

const GSI_URL = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress";
const AREA_JSON_URL = "https://www.jma.go.jp/bosai/common/const/area.json";
const FORECAST_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast";

const AREA_JSON_TTL_MS = 24 * 60 * 60 * 1000;
const MUNI_CD_TTL_MS = 6 * 60 * 60 * 1000;
const SUMMARY_TTL_MS = 10 * 60 * 1000;

interface AreaEntry {
  name: string;
  parent?: string;
}

interface AreaJson {
  class20s: Record<string, AreaEntry>;
  class15s: Record<string, AreaEntry>;
  class10s: Record<string, AreaEntry>;
  offices: Record<string, AreaEntry>;
}

export class NoopWeatherProvider implements WeatherProvider {
  async getWeather(): Promise<WeatherInfo | null> {
    return null;
  }
}

export class JmaWeatherProvider implements WeatherProvider {
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private areaJsonCache = new TtlCache<AreaJson>();
  private muniCdCache = new TtlCache<string>();
  private summaryCache = new TtlCache<string>();

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async getWeather(lat: number, lng: number): Promise<WeatherInfo | null> {
    try {
      const muniCd = await this.resolveMuniCd(lat, lng);
      if (!muniCd) return null;
      const areaJson = await this.loadAreaJson();
      if (!areaJson) return null;
      const resolved = this.resolveOffice(areaJson, muniCd);
      if (!resolved) return null;
      const summaryText = await this.fetchSummary(resolved.office, resolved.class10Code, resolved.areaName);
      if (!summaryText) return null;
      return { summaryText, fetchedAt: new Date().toISOString(), source: "jma" };
    } catch {
      return null;
    }
  }

  private async resolveMuniCd(lat: number, lng: number): Promise<string | null> {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const cached = this.muniCdCache.get(key);
    if (cached !== undefined) return cached;
    const url = `${GSI_URL}?lat=${lat}&lon=${lng}&outtype=json`;
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) return null;
    const json = (await res.json()) as { results?: { muniCd?: string } };
    const muniCd = json.results?.muniCd;
    if (!muniCd) return null;
    this.muniCdCache.set(key, muniCd, MUNI_CD_TTL_MS);
    return muniCd;
  }

  private async loadAreaJson(): Promise<AreaJson | null> {
    const cached = this.areaJsonCache.get("area");
    if (cached !== undefined) return cached;
    const res = await this.fetchFn(AREA_JSON_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) return null;
    const json = (await res.json()) as AreaJson;
    this.areaJsonCache.set("area", json, AREA_JSON_TTL_MS);
    return json;
  }

  private resolveOffice(
    areaJson: AreaJson,
    muniCd: string
  ): { office: string; class10Code: string; areaName: string } | null {
    const exactKey = `${muniCd}00`;
    let class20Code = areaJson.class20s[exactKey] ? exactKey : undefined;
    if (!class20Code) {
      class20Code = Object.keys(areaJson.class20s).find((k) => k.startsWith(muniCd));
    }
    if (!class20Code && muniCd.length >= 5) {
      // 政令市の区コード(例: 熊本市中央区 43101)は市コード(43100)で登録されている
      const cityKey = `${muniCd.slice(0, 4)}000`;
      if (areaJson.class20s[cityKey]) class20Code = cityKey;
    }
    if (!class20Code) return null;

    const class15Entry = areaJson.class20s[class20Code];
    const class15Code = class15Entry?.parent;
    if (!class15Code) return null;

    const class10Entry = areaJson.class15s[class15Code];
    const class10Code = class10Entry?.parent;
    if (!class10Code) return null;

    const class10 = areaJson.class10s[class10Code];
    const officeCode = class10?.parent;
    if (!officeCode || !areaJson.offices[officeCode]) return null;

    return { office: officeCode, class10Code, areaName: class10.name };
  }

  private async fetchSummary(
    office: string,
    class10Code: string,
    areaName: string
  ): Promise<string | null> {
    const key = `${office}:${class10Code}`;
    const cached = this.summaryCache.get(key);
    if (cached !== undefined) return cached;

    const res = await this.fetchFn(`${FORECAST_URL}/${office}.json`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return null;
    const forecast = (await res.json()) as Array<{
      timeSeries: Array<{
        areas: Array<{
          area: { code: string; name: string };
          weathers?: string[];
          pops?: string[];
        }>;
      }>;
    }>;
    const timeSeriesList = forecast[0]?.timeSeries;
    if (!timeSeriesList || timeSeriesList.length === 0) return null;

    let weatherText: string | undefined;
    let pop: string | undefined;
    for (const ts of timeSeriesList) {
      const area =
        ts.areas.find((a) => a.area.code === class10Code) ?? ts.areas[0];
      if (!area) continue;
      if (weatherText === undefined && area.weathers && area.weathers[0]) {
        weatherText = area.weathers[0];
      }
      if (pop === undefined && area.pops && area.pops[0]) {
        pop = area.pops[0];
      }
    }
    if (!weatherText) return null;

    const summary = pop
      ? `${areaName}: ${weatherText} / 降水確率: ${pop}%`
      : `${areaName}: ${weatherText}`;

    this.summaryCache.set(key, summary, SUMMARY_TTL_MS);
    return summary;
  }
}
