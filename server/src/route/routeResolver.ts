import { TtlCache } from "../weather/cache.js";
import type { LocationRow } from "../db/repo.js";

const GSI_REVERSE_GEOCODE_URL =
  "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress";
const MUNI_JS_URL = "https://maps.gsi.go.jp/js/muni.js";

const GEOCODE_TTL_MS = 6 * 60 * 60 * 1000;
const MUNI_NAME_TTL_MS = 24 * 60 * 60 * 1000;

const MIN_POINT_DISTANCE_M = 300;
const MAX_GEOCODE_POINTS = 30;
const GEOCODE_CONCURRENCY = 2;

export interface RoutePoint {
  name: string;
  muniCd: string;
  lat: number;
  lng: number;
  enteredAt: string;
}

interface GeocodeResult {
  muniCd: string;
  lv01Nm: string;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in meters. */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Evenly picks up to maxLen items from arr, preserving order (same approach as the viewer's
 * client-side track decimation). */
function evenlySample<T>(arr: T[], maxLen: number): T[] {
  if (arr.length <= maxLen) return arr;
  const step = arr.length / maxLen;
  const out: T[] = [];
  for (let i = 0; i < maxLen; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

/** Parses GSI's `muni.js` (`GSI.MUNI_ARRAY["43100"]="43,熊本県,43100,熊本市";` lines) into
 * muniCd -> "都道府県名+市区町村名". */
function parseMuniJs(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const muniCd = m[1];
    const fields = m[2].split(",");
    const prefName = fields[1];
    const muniName = fields[3];
    if (prefName && muniName) {
      map.set(muniCd, `${prefName}${muniName}`);
    }
  }
  return map;
}

export class RouteResolver {
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private geocodeCache = new TtlCache<GeocodeResult | null>();
  private muniNameCache = new TtlCache<Map<string, string>>();

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async resolveRoute(points: LocationRow[]): Promise<RoutePoint[]> {
    try {
      if (points.length === 0) return [];
      const sampled = this.downsample(points);
      if (sampled.length === 0) return [];

      const muniNames = await this.loadMuniNames();

      const geocodedByIndex = new Map<number, GeocodeResult>();
      let nextIndex = 0;
      const worker = async () => {
        for (;;) {
          const i = nextIndex++;
          if (i >= sampled.length) return;
          try {
            const result = await this.geocode(sampled[i].lat, sampled[i].lng);
            if (result) geocodedByIndex.set(i, result);
          } catch {
            // skip this point
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(GEOCODE_CONCURRENCY, sampled.length) }, () => worker())
      );

      const route: RoutePoint[] = [];
      for (let i = 0; i < sampled.length; i++) {
        const g = geocodedByIndex.get(i);
        if (!g) continue;
        const muniName = muniNames.get(g.muniCd) ?? g.muniCd;
        const name = g.lv01Nm ? `${muniName} ${g.lv01Nm}` : muniName;
        const last = route[route.length - 1];
        if (last && last.name === name && last.muniCd === g.muniCd) continue;
        route.push({
          name,
          muniCd: g.muniCd,
          lat: sampled[i].lat,
          lng: sampled[i].lng,
          enteredAt: sampled[i].recorded_at,
        });
      }
      return route;
    } catch {
      return [];
    }
  }

  /** Drops consecutive points closer than ~300m together, then caps the remainder at 30 points
   * (evenly spaced) so at most 30 geocode requests are made per resolve. */
  private downsample(points: LocationRow[]): LocationRow[] {
    const distFiltered: LocationRow[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = distFiltered[distFiltered.length - 1];
      const d = haversineMeters(prev.lat, prev.lng, points[i].lat, points[i].lng);
      if (d >= MIN_POINT_DISTANCE_M) distFiltered.push(points[i]);
    }
    return evenlySample(distFiltered, MAX_GEOCODE_POINTS);
  }

  private async geocode(lat: number, lng: number): Promise<GeocodeResult | null> {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    const cached = this.geocodeCache.get(key);
    if (cached !== undefined) return cached;
    const url = `${GSI_REVERSE_GEOCODE_URL}?lat=${lat}&lon=${lng}&outtype=json`;
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      this.geocodeCache.set(key, null, GEOCODE_TTL_MS);
      return null;
    }
    const json = (await res.json()) as { results?: { muniCd?: string; lv01Nm?: string } };
    const muniCd = json.results?.muniCd;
    if (!muniCd) {
      this.geocodeCache.set(key, null, GEOCODE_TTL_MS);
      return null;
    }
    const result: GeocodeResult = { muniCd, lv01Nm: json.results?.lv01Nm ?? "" };
    this.geocodeCache.set(key, result, GEOCODE_TTL_MS);
    return result;
  }

  private async loadMuniNames(): Promise<Map<string, string>> {
    const cached = this.muniNameCache.get("muni");
    if (cached !== undefined) return cached;
    try {
      const res = await this.fetchFn(MUNI_JS_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return new Map();
      const text = await res.text();
      const map = parseMuniJs(text);
      this.muniNameCache.set("muni", map, MUNI_NAME_TTL_MS);
      return map;
    } catch {
      return new Map();
    }
  }
}
