import { randomUUID } from "node:crypto";
import type { DB } from "./index.js";

export interface Session {
  id: string;
  title: string | null;
  device_id: string | null;
  started_at: string;
  ended_at: string | null;
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

export function listSessions(db: DB): Session[] {
  return db
    .prepare(`SELECT * FROM sessions ORDER BY started_at DESC`)
    .all() as Session[];
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
