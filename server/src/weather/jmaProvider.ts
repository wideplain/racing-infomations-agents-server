import { TtlCache } from "./cache.js";
import type {
  PrecipitationOutlook,
  PrecipitationOutlookProvider,
  PrecipitationProbabilitySlot,
  RainForecast,
  WeatherForecast,
  WeatherInfo,
  WeatherProvider,
} from "./types.js";

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

interface ForecastSummary {
  summaryText: string;
  rainForecast?: RainForecast;
  weatherForecast?: WeatherForecast;
  precipitation?: PrecipitationOutlook;
}

/** JMA's last published probability slot has no following entry to bound it; its published
 * slots are six hours wide, so that is what the final slot is assumed to cover. */
const POP_SLOT_MS = 6 * 60 * 60 * 1000;

export class NoopWeatherProvider implements WeatherProvider {
  async getWeather(): Promise<WeatherInfo | null> {
    return null;
  }
}

export class JmaWeatherProvider implements WeatherProvider, PrecipitationOutlookProvider {
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private areaJsonCache = new TtlCache<AreaJson>();
  private muniCdCache = new TtlCache<string>();
  private summaryCache = new TtlCache<ForecastSummary>();

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async getWeather(lat: number, lng: number): Promise<WeatherInfo | null> {
    try {
      const forecast = await this.loadForecast(lat, lng);
      if (!forecast) return null;
      // The probability slots are served by their own endpoint; they stay out of the summary
      // payload so the HUD and the prompt keep seeing exactly the fields they always did.
      const { precipitation: _precipitation, ...info } = forecast;
      return { ...info, fetchedAt: new Date().toISOString(), source: "jma" };
    } catch {
      return null;
    }
  }

  /** Six-hourly precipitation probability for the location's forecast area. Shares the area
   * resolution and the cached office forecast with getWeather, so asking for both is one fetch. */
  async getPrecipitationOutlook(lat: number, lng: number): Promise<PrecipitationOutlook | null> {
    try {
      return (await this.loadForecast(lat, lng))?.precipitation ?? null;
    } catch {
      return null;
    }
  }

  private async loadForecast(lat: number, lng: number): Promise<ForecastSummary | null> {
    const muniCd = await this.resolveMuniCd(lat, lng);
    if (!muniCd) return null;
    const areaJson = await this.loadAreaJson();
    if (!areaJson) return null;
    const resolved = this.resolveOffice(areaJson, muniCd);
    if (!resolved) return null;
    return this.fetchSummary(resolved.office, resolved.class10Code, resolved.areaName);
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
  ): Promise<ForecastSummary | null> {
    const key = `${office}:${class10Code}`;
    const cached = this.summaryCache.get(key);
    if (cached !== undefined) return cached;

    const res = await this.fetchFn(`${FORECAST_URL}/${office}.json`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return null;
    const forecast = (await res.json()) as Array<{
      reportDatetime?: string;
      timeSeries: Array<{
        timeDefines?: string[];
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
    let rainForecast: RainForecast | undefined;
    let weatherForecast: WeatherForecast | undefined;
    let popSlots: PrecipitationProbabilitySlot[] | undefined;
    for (const ts of timeSeriesList) {
      const area =
        ts.areas.find((a) => a.area.code === class10Code) ?? ts.areas[0];
      if (!area) continue;
      if (weatherText === undefined && area.weathers && area.weathers[0]) {
        weatherText = area.weathers[0];
      }
      if (!weatherForecast && area.weathers?.length) {
        weatherForecast = this.findNextWeatherForecast(ts.timeDefines, area.weathers);
      }
      if (pop === undefined && area.pops && area.pops[0]) {
        pop = area.pops[0];
      }
      if (!rainForecast && area.pops && ts.timeDefines) {
        rainForecast = this.findNextRainForecast(ts.timeDefines, area.pops);
      }
      if (!popSlots?.length && area.pops && ts.timeDefines) {
        popSlots = this.buildProbabilitySlots(ts.timeDefines, area.pops);
      }
    }
    if (!weatherText) return null;

    const summaryText = pop
      ? `${areaName}: ${weatherText} / 降水確率: ${pop}%`
      : `${areaName}: ${weatherText}`;
    const summary = {
      summaryText,
      ...(rainForecast ? { rainForecast } : {}),
      ...(weatherForecast ?? weatherText
        ? { weatherForecast: weatherForecast ?? { etaMinutes: 0, weather: weatherText } }
        : {}),
      ...(popSlots?.length
        ? {
            precipitation: {
              areaName,
              reportedAt: forecast[0]?.reportDatetime ?? null,
              slots: popSlots,
            },
          }
        : {}),
    };

    this.summaryCache.set(key, summary, SUMMARY_TTL_MS);
    return summary;
  }

  /** Every published slot, not just the next rainy one, so the weather screen can show how the
   * chance of rain moves across the day. Slots JMA leaves blank are dropped rather than shown
   * as 0%, and each slot is bounded by the following one. */
  private buildProbabilitySlots(timeDefines: string[], pops: string[]): PrecipitationProbabilitySlot[] {
    const slots: PrecipitationProbabilitySlot[] = [];
    for (let index = 0; index < Math.min(timeDefines.length, pops.length); index++) {
      const probability = Number(pops[index]);
      const startAt = new Date(timeDefines[index]).getTime();
      if (pops[index] === "" || !Number.isFinite(probability) || !Number.isFinite(startAt)) continue;
      const nextAt = index + 1 < timeDefines.length ? new Date(timeDefines[index + 1]).getTime() : NaN;
      const endAt = Number.isFinite(nextAt) ? nextAt : startAt + POP_SLOT_MS;
      slots.push({
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
        probability,
      });
    }
    return slots;
  }

  /** JMA precipitation probabilities are published in time slots. Surface the next slot at 50%
   * or above so the HUD can show a factual, short rain heads-up without asking the model to
   * infer weather. */
  private findNextRainForecast(timeDefines: string[], pops: string[]): RainForecast | undefined {
    const now = Date.now();
    for (let index = 0; index < Math.min(timeDefines.length, pops.length); index++) {
      const probability = Number(pops[index]);
      const at = new Date(timeDefines[index]).getTime();
      if (!Number.isFinite(probability) || probability < 50 || !Number.isFinite(at)) continue;
      return {
        etaMinutes: Math.max(0, Math.round((at - now) / 60_000)),
        probability,
      };
    }
    return undefined;
  }

  private findNextWeatherForecast(
    timeDefines: string[] | undefined,
    weathers: string[]
  ): WeatherForecast | undefined {
    if (weathers.length === 0) return undefined;
    const now = Date.now();
    if (!timeDefines?.length) return { etaMinutes: 0, weather: weathers[0] };
    for (let index = 0; index < Math.min(timeDefines.length, weathers.length); index++) {
      const at = new Date(timeDefines[index]).getTime();
      if (!Number.isFinite(at)) continue;
      if (at >= now || index === timeDefines.length - 1) {
        return { etaMinutes: Math.max(0, Math.round((at - now) / 60_000)), weather: weathers[index] };
      }
    }
    return { etaMinutes: 0, weather: weathers[0] };
  }
}
