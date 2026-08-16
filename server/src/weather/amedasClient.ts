import { TtlCache } from "./cache.js";

const LATEST_TIME_URL = "https://www.jma.go.jp/bosai/amedas/data/latest_time.txt";
const STATION_TABLE_URL = "https://www.jma.go.jp/bosai/amedas/const/amedastable.json";
const STATION_TABLE_TTL_MS = 24 * 60 * 60 * 1000;

export interface AmedasObservation {
  observedAt: string | null;
  stationId: string | null;
  stationDistanceKm: number | null;
  temperatureC: number | null;
  humidityPercent: number | null;
  windSpeedMs: number | null;
}

interface AmedasStation {
  id: string;
  latitude: number;
  longitude: number;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function coordinate(value: unknown): number | null {
  if (!Array.isArray(value) || typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return value[0] + value[1] / 60;
}

function observationNumber(value: unknown): number | null {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function amedasTimestamp(iso: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  // The AMeDAS URL names are Japan Standard Time timestamps, not UTC strings.
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}${pad(jst.getUTCMonth() + 1)}${pad(jst.getUTCDate())}${pad(jst.getUTCHours())}${pad(jst.getUTCMinutes())}00`;
}

export class JmaAmedasClient {
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private stationCache = new TtlCache<AmedasStation[]>();
  private latestTimeCache = new TtlCache<string | null>();
  private valuesCache = new TtlCache<Record<string, unknown> | null>();
  private nearestCache: { latitude: number; longitude: number; station: AmedasStation; distanceKm: number } | null = null;

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async getObservation(latitude: number, longitude: number): Promise<AmedasObservation> {
    try {
      const [stations, latestTime] = await Promise.all([this.getStations(), this.getLatestTime()]);
      if (!stations.length || !latestTime) return this.emptyObservation();
      const station = this.findNearestStation(stations, latitude, longitude);
      const timestamp = amedasTimestamp(latestTime);
      if (!timestamp) return this.emptyObservation();
      const values = await this.getValues(timestamp);
      const row = values?.[station.id] as Record<string, unknown> | undefined;
      return {
        observedAt: latestTime,
        stationId: station.id,
        stationDistanceKm: station.distanceKm,
        temperatureC: observationNumber(row?.temp),
        humidityPercent: observationNumber(row?.humidity),
        windSpeedMs: observationNumber(row?.wind),
      };
    } catch {
      return this.emptyObservation();
    }
  }

  private emptyObservation(): AmedasObservation {
    return { observedAt: null, stationId: null, stationDistanceKm: null, temperatureC: null, humidityPercent: null, windSpeedMs: null };
  }

  private async getStations(): Promise<AmedasStation[]> {
    const cached = this.stationCache.get("stations");
    if (cached !== undefined) return cached;
    const response = await this.fetchFn(STATION_TABLE_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) return [];
    const json = (await response.json()) as Record<string, { lat?: unknown; lon?: unknown }>;
    const stations = Object.entries(json).flatMap(([id, station]) => {
      const latitude = coordinate(station.lat);
      const longitude = coordinate(station.lon);
      return latitude === null || longitude === null ? [] : [{ id, latitude, longitude }];
    });
    this.stationCache.set("stations", stations, STATION_TABLE_TTL_MS);
    return stations;
  }

  private async getLatestTime(): Promise<string | null> {
    const cached = this.latestTimeCache.get("latest");
    if (cached !== undefined) return cached;
    const response = await this.fetchFn(LATEST_TIME_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) return null;
    const value = (await response.text()).trim();
    const valid = Number.isFinite(new Date(value).getTime()) ? value : null;
    this.latestTimeCache.set("latest", valid, 60_000);
    return valid;
  }

  private async getValues(timestamp: string): Promise<Record<string, unknown> | null> {
    const cached = this.valuesCache.get(timestamp);
    if (cached !== undefined) return cached;
    const response = await this.fetchFn(`https://www.jma.go.jp/bosai/amedas/data/map/${timestamp}.json`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return null;
    const values = (await response.json()) as Record<string, unknown>;
    this.valuesCache.set(timestamp, values, 30 * 60 * 1000);
    return values;
  }

  private findNearestStation(stations: AmedasStation[], latitude: number, longitude: number): { id: string; distanceKm: number } {
    if (this.nearestCache && haversineKm(latitude, longitude, this.nearestCache.latitude, this.nearestCache.longitude) < 3) {
      return { id: this.nearestCache.station.id, distanceKm: haversineKm(latitude, longitude, this.nearestCache.station.latitude, this.nearestCache.station.longitude) };
    }
    let nearest = stations[0];
    let distanceKm = haversineKm(latitude, longitude, nearest.latitude, nearest.longitude);
    for (const station of stations.slice(1)) {
      const distance = haversineKm(latitude, longitude, station.latitude, station.longitude);
      if (distance < distanceKm) {
        nearest = station;
        distanceKm = distance;
      }
    }
    this.nearestCache = { latitude, longitude, station: nearest, distanceKm };
    return { id: nearest.id, distanceKm };
  }
}

export { haversineKm };
