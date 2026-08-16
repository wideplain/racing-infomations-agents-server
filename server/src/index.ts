import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createProvider } from "./ai/registry.js";
import { buildApp } from "./app.js";
import { WeatherService, NoopWeatherSnapshotProvider } from "./weather/weatherService.js";

async function main() {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const provider = createProvider(config);
  const weatherSnapshotProvider = config.weatherEnabled
    ? new WeatherService()
    : new NoopWeatherSnapshotProvider();
  const app = await buildApp({ db, config, provider, weatherSnapshotProvider });

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
