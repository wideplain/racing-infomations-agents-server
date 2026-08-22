import type { DB } from "./index.js";

export function migrate(db: DB): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      device_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      client_seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      is_final INTEGER NOT NULL DEFAULT 1,
      excluded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, client_seq),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'default',
      prompt TEXT,
      raw_output TEXT,
      result_json TEXT,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy_m REAL,
      speed_mps REAL,
      bearing_deg REAL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- One row per session: where the pit crew's own screen is, not the car. Weather lookups
    -- prefer this over the car's GPS track (see resolveWeatherLocation in routes/analyze.ts).
    CREATE TABLE IF NOT EXISTS pit_locations (
      session_id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy_m REAL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS weather_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      recorded_minute TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      is_raining INTEGER,
      precipitation_intensity REAL,
      temperature_c REAL,
      humidity_percent REAL,
      wind_speed_ms REAL,
      weather_observed_at TEXT,
      rain_source_observed_at TEXT,
      amedas_observed_at TEXT,
      amedas_station_id TEXT,
      amedas_station_distance_km REAL,
      rain_source TEXT,
      temperature_source TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, recorded_minute),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id, client_seq);
    CREATE INDEX IF NOT EXISTS idx_analyses_session ON analyses(session_id);
    CREATE INDEX IF NOT EXISTS idx_locations_session ON locations(session_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_weather_snapshots_session ON weather_snapshots(session_id, recorded_at);
  `);

  // Older DBs created before the "excluded" (archive) column existed: add it if missing.
  const columns = db.prepare(`PRAGMA table_info(segments)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === "excluded")) {
    db.exec(`ALTER TABLE segments ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0`);
  }

  // Older DBs created before the "mode" (analysis mode, e.g. "pitwall") column existed: add it if missing.
  const analysisColumns = db.prepare(`PRAGMA table_info(analyses)`).all() as {
    name: string;
  }[];
  if (!analysisColumns.some((c) => c.name === "mode")) {
    db.exec(`ALTER TABLE analyses ADD COLUMN mode TEXT NOT NULL DEFAULT 'default'`);
  }
}
