import { randomUUID } from "node:crypto";
import type { DB } from "./index.js";
import type { WeatherSnapshot, WeatherSnapshotInput } from "../weather/types.js";

export interface Session {
  id: string;
  title: string | null;
  device_id: string | null;
  started_at: string;
  ended_at: string | null;
}

/** A session plus the aggregates the session list renders. */
export interface SessionSummary extends Session {
  segment_count: number;
  analysis_count: number;
  last_segment_at: string | null;
}

export interface Segment {
  id: number;
  session_id: string;
  client_seq: number;
  text: string;
  is_final: number;
  excluded: number;
  created_at: string;
}

export interface Analysis {
  id: string;
  session_id: string;
  status: "queued" | "running" | "done" | "error";
  provider: string;
  mode: string;
  prompt: string | null;
  raw_output: string | null;
  result_json: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface LocationRow {
  id: number;
  session_id: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  bearing_deg: number | null;
  recorded_at: string;
  created_at: string;
}

export interface WeatherSnapshotRow {
  id: number;
  session_id: string;
  recorded_at: string;
  recorded_minute: string;
  latitude: number;
  longitude: number;
  is_raining: number | null;
  precipitation_intensity: number | null;
  temperature_c: number | null;
  humidity_percent: number | null;
  wind_speed_ms: number | null;
  weather_observed_at: string | null;
  rain_source_observed_at: string | null;
  amedas_observed_at: string | null;
  amedas_station_id: string | null;
  amedas_station_distance_km: number | null;
  rain_source: string | null;
  temperature_source: string | null;
  created_at: string;
}

export function createSession(
  db: DB,
  input: { title?: string; deviceId?: string }
): Session {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, title, device_id, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)`
  ).run(id, input.title ?? null, input.deviceId ?? null, now);
  return getSession(db, id) as Session;
}

export function endSession(db: DB, id: string): Session | undefined {
  const now = new Date().toISOString();
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(now, id);
  return getSession(db, id);
}

export function getSession(db: DB, id: string): Session | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    | Session
    | undefined;
}

/** The list view needs enough per-session context to pick one without opening it, so the counts
 * are aggregated here instead of making the client fetch every session's detail (N+1). */
export function listSessions(db: DB): SessionSummary[] {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM segments WHERE session_id = s.id) AS segment_count,
              (SELECT COUNT(*) FROM analyses WHERE session_id = s.id) AS analysis_count,
              (SELECT MAX(created_at) FROM segments WHERE session_id = s.id) AS last_segment_at
       FROM sessions s
       ORDER BY s.started_at DESC`
    )
    .all() as SessionSummary[];
}

export function insertSegments(
  db: DB,
  sessionId: string,
  segments: { clientSeq: number; text: string; isFinal?: boolean }[]
): { inserted: number } {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO segments (session_id, client_seq, text, is_final, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, client_seq) DO NOTHING`
  );
  const tx = db.transaction((rows: typeof segments) => {
    let inserted = 0;
    for (const row of rows) {
      const info = stmt.run(
        sessionId,
        row.clientSeq,
        row.text,
        row.isFinal === false ? 0 : 1,
        now
      );
      if (info.changes > 0) inserted++;
    }
    return inserted;
  });
  const inserted = tx(segments);
  return { inserted };
}

export function listSegments(db: DB, sessionId: string): Segment[] {
  return db
    .prepare(
      `SELECT * FROM segments WHERE session_id = ? ORDER BY client_seq ASC`
    )
    .all(sessionId) as Segment[];
}

/** Segments eligible for AI analysis context (excludes archived lines). */
export function listSegmentsForAnalysis(db: DB, sessionId: string): Segment[] {
  return db
    .prepare(
      `SELECT * FROM segments WHERE session_id = ? AND excluded = 0 ORDER BY client_seq ASC`
    )
    .all(sessionId) as Segment[];
}

export function updateSegment(
  db: DB,
  sessionId: string,
  clientSeq: number,
  patch: { text?: string; excluded?: boolean }
): Segment | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.text !== undefined) {
    fields.push("text = ?");
    values.push(patch.text);
  }
  if (patch.excluded !== undefined) {
    fields.push("excluded = ?");
    values.push(patch.excluded ? 1 : 0);
  }
  if (fields.length === 0) {
    return db
      .prepare(`SELECT * FROM segments WHERE session_id = ? AND client_seq = ?`)
      .get(sessionId, clientSeq) as Segment | undefined;
  }
  db.prepare(
    `UPDATE segments SET ${fields.join(", ")} WHERE session_id = ? AND client_seq = ?`
  ).run(...values, sessionId, clientSeq);
  return db
    .prepare(`SELECT * FROM segments WHERE session_id = ? AND client_seq = ?`)
    .get(sessionId, clientSeq) as Segment | undefined;
}

export function insertLocations(
  db: DB,
  sessionId: string,
  points: {
    lat: number;
    lng: number;
    accuracyM?: number;
    speedMps?: number;
    bearingDeg?: number;
    recordedAt: string;
  }[]
): { inserted: number } {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO locations (session_id, lat, lng, accuracy_m, speed_mps, bearing_deg, recorded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((rows: typeof points) => {
    let inserted = 0;
    for (const row of rows) {
      const info = stmt.run(
        sessionId,
        row.lat,
        row.lng,
        row.accuracyM ?? null,
        row.speedMps ?? null,
        row.bearingDeg ?? null,
        row.recordedAt,
        now
      );
      if (info.changes > 0) inserted++;
    }
    return inserted;
  });
  const inserted = tx(points);
  return { inserted };
}

export function getLatestLocation(db: DB, sessionId: string): LocationRow | undefined {
  return db
    .prepare(`SELECT * FROM locations WHERE session_id = ? ORDER BY id DESC LIMIT 1`)
    .get(sessionId) as LocationRow | undefined;
}

export function listLocations(
  db: DB,
  sessionId: string,
  opts: { afterId?: number; limit?: number } = {}
): LocationRow[] {
  const afterId = opts.afterId ?? 0;
  const limit = opts.limit ?? 500;
  return db
    .prepare(
      `SELECT * FROM locations WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
    )
    .all(sessionId, afterId, limit) as LocationRow[];
}

function minuteKey(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso.slice(0, 16);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

/** Reserves exactly one weather snapshot for each device-time minute. Reserving before an
 * external request makes duplicate/retried GPS posts cheap and preserves a null snapshot when
 * JMA is unavailable instead of blocking location ingestion. */
export function reserveWeatherSnapshot(
  db: DB,
  input: { sessionId: string; recordedAt: string; latitude: number; longitude: number }
): WeatherSnapshotRow | undefined {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO weather_snapshots (
      session_id, recorded_at, recorded_minute, latitude, longitude,
      is_raining, precipitation_intensity, temperature_c, humidity_percent, wind_speed_ms,
      weather_observed_at, rain_source_observed_at, amedas_observed_at,
      amedas_station_id, amedas_station_distance_km, rain_source, temperature_source, created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT(session_id, recorded_minute) DO NOTHING`
  ).run(input.sessionId, input.recordedAt, minuteKey(input.recordedAt), input.latitude, input.longitude, now);
  if (info.changes === 0) return undefined;
  return db.prepare(`SELECT * FROM weather_snapshots WHERE id = ?`).get(info.lastInsertRowid) as WeatherSnapshotRow;
}

export function updateWeatherSnapshot(db: DB, id: number, weather: WeatherSnapshotInput): void {
  db.prepare(
    `UPDATE weather_snapshots SET
      is_raining = ?, precipitation_intensity = ?, temperature_c = ?, humidity_percent = ?, wind_speed_ms = ?,
      weather_observed_at = ?, rain_source_observed_at = ?, amedas_observed_at = ?,
      amedas_station_id = ?, amedas_station_distance_km = ?, rain_source = ?, temperature_source = ?
     WHERE id = ?`
  ).run(
    weather.isRaining === null ? null : weather.isRaining ? 1 : 0,
    weather.precipitationIntensity,
    weather.temperatureC,
    weather.humidityPercent,
    weather.windSpeedMs,
    weather.weatherObservedAt,
    weather.rainSourceObservedAt,
    weather.amedasObservedAt,
    weather.amedasStationId,
    weather.amedasStationDistanceKm,
    weather.source.rain,
    weather.source.temperature,
    id
  );
}

export function listWeatherSnapshots(db: DB, sessionId: string, limit = 500): WeatherSnapshot[] {
  const rows = db.prepare(
    `SELECT * FROM weather_snapshots WHERE session_id = ? ORDER BY recorded_at ASC LIMIT ?`
  ).all(sessionId, limit) as WeatherSnapshotRow[];
  return rows.map(toWeatherSnapshot);
}

export function getLatestWeatherSnapshot(db: DB, sessionId: string): WeatherSnapshot | null {
  const row = db.prepare(
    `SELECT * FROM weather_snapshots WHERE session_id = ? ORDER BY recorded_at DESC LIMIT 1`
  ).get(sessionId) as WeatherSnapshotRow | undefined;
  return row ? toWeatherSnapshot(row) : null;
}

function toWeatherSnapshot(row: WeatherSnapshotRow): WeatherSnapshot {
  return {
    recordedAt: row.recorded_at,
    latitude: row.latitude,
    longitude: row.longitude,
    isRaining: row.is_raining === null ? null : row.is_raining === 1,
    precipitationIntensity: row.precipitation_intensity,
    temperatureC: row.temperature_c,
    humidityPercent: row.humidity_percent,
    windSpeedMs: row.wind_speed_ms,
    weatherObservedAt: row.weather_observed_at,
    rainSourceObservedAt: row.rain_source_observed_at,
    amedasObservedAt: row.amedas_observed_at,
    amedasStationId: row.amedas_station_id,
    amedasStationDistanceKm: row.amedas_station_distance_km,
    source: {
      rain: row.rain_source === "jma-nowcast" ? "jma-nowcast" : null,
      temperature: row.temperature_source === "jma-amedas" ? "jma-amedas" : null,
    },
  };
}

export function createAnalysis(
  db: DB,
  input: { sessionId: string; provider: string; prompt: string; mode?: string }
): Analysis {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO analyses (id, session_id, status, provider, mode, prompt, raw_output, result_json, error, duration_ms, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`
  ).run(
    id,
    input.sessionId,
    input.provider,
    input.mode ?? "default",
    input.prompt,
    now,
    now
  );
  return getAnalysis(db, id) as Analysis;
}

export function getAnalysis(db: DB, id: string): Analysis | undefined {
  return db.prepare(`SELECT * FROM analyses WHERE id = ?`).get(id) as
    | Analysis
    | undefined;
}

/** Most recent `limit` completed analyses for a session, newest first, filtered by mode. */
export function listRecentAnalyses(
  db: DB,
  sessionId: string,
  opts: { mode: string; status: Analysis["status"]; limit: number }
): Analysis[] {
  return db
    .prepare(
      `SELECT * FROM analyses WHERE session_id = ? AND mode = ? AND status = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(sessionId, opts.mode, opts.status, opts.limit) as Analysis[];
}

/** All analyses for a session regardless of mode/status, oldest first — for the read-only
 * viewer page, which renders a single timeline rather than filtering like the app does. */
export function listAnalysesForSession(db: DB, sessionId: string, limit = 100): Analysis[] {
  return db
    .prepare(
      `SELECT * FROM analyses WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
    )
    .all(sessionId, limit) as Analysis[];
}

export function updateAnalysis(
  db: DB,
  id: string,
  patch: Partial<
    Pick<
      Analysis,
      "status" | "prompt" | "raw_output" | "result_json" | "error" | "duration_ms"
    >
  >
): void {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const now = new Date().toISOString();
  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => (patch as Record<string, unknown>)[f]);
  db.prepare(
    `UPDATE analyses SET ${setClause}, updated_at = ? WHERE id = ?`
  ).run(...values, now, id);
}
