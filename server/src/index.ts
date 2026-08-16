import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { createProvider } from "./ai/registry.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const provider = createProvider(config);
  const app = await buildApp({ db, config, provider });

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
