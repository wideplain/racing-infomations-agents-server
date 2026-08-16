import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "./db/index.js";
import type { Config } from "./config.js";
import type { AIProvider } from "./ai/types.js";
import type { WeatherProvider } from "./weather/types.js";
import { JmaWeatherProvider, NoopWeatherProvider } from "./weather/jmaProvider.js";
import { SerialQueue } from "./analysis/queue.js";
import { RouteResolver } from "./route/routeResolver.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAnalyzeRoutes } from "./routes/analyze.js";
import { registerWsRoutes } from "./routes/ws.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppDeps {
  db: DB;
  config: Config;
  provider: AIProvider;
  queue?: SerialQueue;
  weather?: WeatherProvider;
  routeResolver?: RouteResolver;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const queue = deps.queue ?? new SerialQueue(5);
  const weather =
    deps.weather ??
    (deps.config.weatherEnabled
      ? new JmaWeatherProvider({ timeoutMs: deps.config.weatherTimeoutMs })
      : new NoopWeatherProvider());
  const routeResolver = deps.routeResolver ?? new RouteResolver();

  await app.register(fastifyStatic, {
    root: join(__dirname, "..", "public"),
    prefix: "/",
  });

  await app.register(fastifyWebsocket);

  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;
    // Tailnet-only PoC: leave API_KEY unset/empty to disable the check entirely.
    if (!deps.config.apiKey) return;
    const apiKey = request.headers["x-api-key"];
    if (apiKey !== deps.config.apiKey) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  await app.register(
    async (instance) => {
      registerSessionRoutes(instance, deps.db, routeResolver);
      registerAnalyzeRoutes(instance, deps.db, deps.provider, queue, weather);
    },
    { prefix: "/api" }
  );

  registerWsRoutes(app, deps.db);

  return app;
}
