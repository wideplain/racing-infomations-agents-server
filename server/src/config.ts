export interface Config {
  port: number;
  host: string;
  apiKey: string;
  dbPath: string;
  aiProvider: string;
  codexBin: string;
  analyzeTimeoutMs: number;
  codexHome: string | undefined;
  weatherEnabled: boolean;
  weatherTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    apiKey: env.API_KEY ?? "",
    dbPath: env.DB_PATH ?? "./data/app.db",
    aiProvider: env.AI_PROVIDER ?? "codex",
    codexBin: env.CODEX_BIN ?? "codex",
    analyzeTimeoutMs: Number(env.ANALYZE_TIMEOUT_MS ?? 120000),
    codexHome: env.CODEX_HOME || undefined,
    weatherEnabled: env.WEATHER_ENABLED === "false" || env.WEATHER_ENABLED === "0" ? false : true,
    weatherTimeoutMs: Number(env.WEATHER_TIMEOUT_MS ?? 4000),
  };
}
