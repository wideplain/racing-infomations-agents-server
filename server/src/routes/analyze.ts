import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { AIProvider } from "../ai/types.js";
import type {
  RainForecast,
  WeatherForecast,
  WeatherProvider,
  WeatherSnapshot,
  WeatherSnapshotInput,
  WeatherSnapshotProvider,
  RainNowcastProvider,
  PrecipitationOutlookProvider,
} from "../weather/types.js";
import { SerialQueue, QueueFullError } from "../analysis/queue.js";
import {
  buildPrompt,
  buildPitwallPrompt,
  buildDriverPrompt,
  type PitwallDecision,
} from "../analysis/prompt.js";
import { parsePitwallAnalysis, parseDriverAnalysis } from "../analysis/parse.js";
import { PITWALL_SCHEMA_PATH, DRIVER_SCHEMA_PATH } from "../ai/codexProvider.js";
import {
  getSession,
  listSegmentsForAnalysis,
  createAnalysis,
  getAnalysis,
  updateAnalysis,
  listRecentAnalyses,
  getLatestLocation,
  getLatestWeatherSnapshot,
} from "../db/repo.js";

const WEATHER_LOCATION_MAX_AGE_MS = 10 * 60 * 1000;

type AnalyzeMode = "default" | "pitwall" | "driver";

function isAnalyzeMode(value: unknown): value is AnalyzeMode {
  return value === "default" || value === "pitwall" || value === "driver";
}

interface PreparedPrompt {
  prompt: string;
  schemaPath?: string;
}

interface PromptSegmentInput {
  clientSeq: number;
  text: string;
  createdAt: string;
}

/** Builds the prompt + schema for one mode. Prior analyses of the *same* mode are fed back in as
 * "these are the notes so far" context, so each mode's history stays self-consistent. */
function preparePrompt(
  db: DB,
  sessionId: string,
  sessionStartedAt: string,
  segments: PromptSegmentInput[],
  mode: AnalyzeMode,
  instruction: string | undefined
): PreparedPrompt {
  if (mode === "pitwall") {
    const decisions: PitwallDecision[] = listRecentAnalyses(db, sessionId, {
      mode: "pitwall",
      status: "done",
      limit: 5,
    }).map((a) => {
      const parsed = a.result_json ? JSON.parse(a.result_json) : {};
      return {
        createdAt: a.created_at,
        proposal: parsed.proposal ?? "",
        statusSummary: parsed.statusSummary ?? "",
      };
    });
    return {
      prompt: buildPitwallPrompt(segments, sessionStartedAt, decisions, { instruction }),
      schemaPath: PITWALL_SCHEMA_PATH,
    };
  }
  if (mode === "driver") {
    const decisions: PitwallDecision[] = listRecentAnalyses(db, sessionId, {
      mode: "driver",
      status: "done",
      limit: 5,
    }).map((a) => {
      const parsed = a.result_json ? JSON.parse(a.result_json) : {};
      return {
        createdAt: a.created_at,
        proposal: parsed.action ?? "",
        statusSummary: parsed.headline ?? "",
      };
    });
    return {
      prompt: buildDriverPrompt(segments, sessionStartedAt, decisions, { instruction }),
      schemaPath: DRIVER_SCHEMA_PATH,
    };
  }
  return { prompt: buildPrompt(segments, sessionStartedAt, { instruction }) };
}

function serializeResult(
  mode: AnalyzeMode,
  result: Awaited<ReturnType<AIProvider["analyze"]>>,
  rainForecast?: RainForecast,
  weatherForecast?: WeatherForecast
): string {
  if (mode === "pitwall") return JSON.stringify(parsePitwallAnalysis(result.rawOutput));
  if (mode === "driver") {
    return JSON.stringify({
      ...parseDriverAnalysis(result.rawOutput),
      ...(rainForecast
        ? { rainEtaMinutes: rainForecast.etaMinutes, rainProbability: rainForecast.probability }
        : {}),
      ...(weatherForecast
        ? { forecastEtaMinutes: weatherForecast.etaMinutes, forecastWeather: weatherForecast.weather }
        : {}),
    });
  }
  return JSON.stringify({
    summary: result.summary,
    interpretation: result.interpretation,
    advice: result.advice,
    suggested_response: result.suggested_response,
    confidence: result.confidence,
    notes: result.notes,
    parseFallback: result.parseFallback,
  });
}

/** Creates the DB row and queues the codex run for one analysis, returning its id. */
function enqueueAnalysis(
  deps: {
    db: DB;
    provider: AIProvider;
    queue: SerialQueue;
    weather: WeatherProvider;
  },
  sessionId: string,
  mode: AnalyzeMode,
  prepared: PreparedPrompt,
  location: { lat: number; lng: number } | undefined
): string {
  const { db, provider, queue, weather } = deps;
  const analysis = createAnalysis(db, {
    sessionId,
    provider: provider.name,
    prompt: prepared.prompt,
    mode,
  });
  queue
    .enqueue(async () => {
      let finalPrompt = prepared.prompt;
      let rainForecast: RainForecast | undefined;
      let weatherForecast: WeatherForecast | undefined;
      if (mode === "driver") {
        let weatherText = "(天気情報なし)";
        let weatherLocation = location;
        if (!weatherLocation) {
          const latest = getLatestLocation(db, sessionId);
          if (latest) {
            const ageMs = Date.now() - new Date(latest.recorded_at).getTime();
            if (ageMs <= WEATHER_LOCATION_MAX_AGE_MS) {
              weatherLocation = { lat: latest.lat, lng: latest.lng };
            }
          }
        }
        if (weatherLocation) {
          try {
            const result = await weather.getWeather(weatherLocation.lat, weatherLocation.lng);
            if (result?.summaryText) {
              weatherText = result.summaryText;
              rainForecast = result.rainForecast;
              weatherForecast = result.weatherForecast;
            }
          } catch {
            // fall through to the no-weather placeholder
          }
        }
        finalPrompt = prepared.prompt.replace("{{WEATHER}}", weatherText);
      }
      updateAnalysis(db, analysis.id, { status: "running", prompt: finalPrompt });
      try {
        const result = await provider.analyze({ prompt: finalPrompt, schemaPath: prepared.schemaPath });
        updateAnalysis(db, analysis.id, {
          status: "done",
          raw_output: result.rawOutput,
          result_json: serializeResult(mode, result, rainForecast, weatherForecast),
          duration_ms: result.durationMs,
        });
      } catch (err) {
        updateAnalysis(db, analysis.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
    .catch(() => {
      // any throw from the task itself is already handled above;
      // this catch only guards against unexpected rejections.
    });
  return analysis.id;
}

function toCurrentWeatherSnapshot(
  location: { lat: number; lng: number },
  weather: WeatherSnapshotInput
): WeatherSnapshot {
  return {
    recordedAt: new Date().toISOString(),
    latitude: location.lat,
    longitude: location.lng,
    ...weather,
  };
}

function isRainNowcastProvider(value: unknown): value is RainNowcastProvider {
  return typeof (value as Partial<RainNowcastProvider> | undefined)?.getRainTimeline === "function";
}

function isPrecipitationOutlookProvider(value: unknown): value is PrecipitationOutlookProvider {
  return typeof (value as Partial<PrecipitationOutlookProvider> | undefined)?.getPrecipitationOutlook === "function";
}

export function registerAnalyzeRoutes(
  app: FastifyInstance,
  db: DB,
  provider: AIProvider,
  queue: SerialQueue,
  weather: WeatherProvider,
  weatherSnapshotProvider?: WeatherSnapshotProvider
): void {
  // Weather is also available independently of an AI run. The driver HUD must not keep showing
  // an old forecast merely because the last driver analysis predates the first GPS fix.
  app.get<{ Params: { id: string } }>(
    "/sessions/:id/weather",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const storedSnapshot = getLatestWeatherSnapshot(db, session.id);

      const location = getLatestLocation(db, session.id);
      if (!location)
        return reply.send({ weather: null, snapshot: storedSnapshot, precipitation: null, reason: "location_unavailable" });
      const ageMs = Date.now() - new Date(location.recorded_at).getTime();
      if (!Number.isFinite(ageMs) || ageMs > WEATHER_LOCATION_MAX_AGE_MS) {
        return reply.send({ weather: null, snapshot: storedSnapshot, precipitation: null, reason: "location_stale" });
      }

      // The route screen needs values for the *current GPS point*, not merely the latest
      // persisted minute snapshot. Source timestamps remain in the response so a fresh page
      // request never pretends that an older AMeDAS observation is a live measurement.
      const [forecastResult, currentResult, precipitationResult] = await Promise.allSettled([
        weather.getWeather(location.lat, location.lng),
        weatherSnapshotProvider?.getWeather(location.lat, location.lng) ?? Promise.resolve(null),
        isPrecipitationOutlookProvider(weather)
          ? weather.getPrecipitationOutlook(location.lat, location.lng)
          : Promise.resolve(null),
      ]);
      const current = currentResult.status === "fulfilled" ? currentResult.value : null;
      const snapshot = current ? toCurrentWeatherSnapshot(location, current) : storedSnapshot;
      const forecast = forecastResult.status === "fulfilled" ? forecastResult.value : null;
      if (precipitationResult.status === "rejected") {
        request.log.warn({ err: precipitationResult.reason }, "precipitation outlook unavailable");
      }
      const precipitation = precipitationResult.status === "fulfilled" ? precipitationResult.value : null;
      return reply.send({
        weather: forecast,
        snapshot,
        precipitation,
        ...(forecastResult.status === "rejected" ? { reason: "weather_unavailable" } : {}),
      });
    }
  );

  // Future rain is a different data product from the stored weather snapshots. N2 contains the
  // high-resolution nowcast forecast in five-minute steps through the next hour, and the area
  // forecast adds probability per six-hour slot; the two are returned side by side but never
  // merged, because they do not share a granularity.
  app.get<{ Params: { id: string } }>(
    "/sessions/:id/weather-timeline",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const location = getLatestLocation(db, session.id);
      if (!location) return reply.send({ timeline: null, precipitation: null, reason: "location_unavailable" });
      const ageMs = Date.now() - new Date(location.recorded_at).getTime();
      if (!Number.isFinite(ageMs) || ageMs > WEATHER_LOCATION_MAX_AGE_MS) {
        return reply.send({ timeline: null, precipitation: null, reason: "location_stale" });
      }
      const [timelineResult, precipitationResult] = await Promise.allSettled([
        isRainNowcastProvider(weatherSnapshotProvider)
          ? weatherSnapshotProvider.getRainTimeline(location.lat, location.lng)
          : Promise.resolve(null),
        isPrecipitationOutlookProvider(weather)
          ? weather.getPrecipitationOutlook(location.lat, location.lng)
          : Promise.resolve(null),
      ]);
      if (timelineResult.status === "rejected") {
        request.log.warn({ err: timelineResult.reason }, "weather timeline unavailable");
      }
      if (precipitationResult.status === "rejected") {
        request.log.warn({ err: precipitationResult.reason }, "precipitation outlook unavailable");
      }
      const timeline = timelineResult.status === "fulfilled" ? timelineResult.value : null;
      const precipitation = precipitationResult.status === "fulfilled" ? precipitationResult.value : null;
      return reply.send({
        timeline,
        precipitation,
        location: { latitude: location.lat, longitude: location.lng, recordedAt: location.recorded_at },
        ...(timeline || precipitation ? {} : { reason: "weather_unavailable" }),
      });
    }
  );

  app.post<{
    Params: { id: string };
    Body:
      | {
          mode?: string;
          instruction?: string;
          location?: { lat: number; lng: number };
          alsoDriver?: boolean;
        }
      | undefined;
  }>(
    "/sessions/:id/analyze",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });

      const bodyMode = request.body?.mode;
      if (bodyMode !== undefined && !isAnalyzeMode(bodyMode)) {
        return reply.code(400).send({ error: "invalid_mode" });
      }
      const mode: AnalyzeMode = bodyMode ?? "default";
      const instruction = request.body?.instruction;
      if (instruction !== undefined && typeof instruction !== "string") {
        return reply.code(400).send({ error: "invalid_instruction" });
      }
      const location = request.body?.location;
      if (location !== undefined) {
        const validLat =
          typeof location.lat === "number" && location.lat >= -90 && location.lat <= 90;
        const validLng =
          typeof location.lng === "number" && location.lng >= -180 && location.lng <= 180;
        if (!validLat || !validLng) {
          return reply.code(400).send({ error: "invalid_location" });
        }
      }

      // "Also generate a driver summary": one request fans out into two independent codex runs —
      // the requested mode's detailed analysis, plus a short driver-mode one stored separately.
      // The web viewer's driver display then just switches which entries it shows, instead of
      // having to compress a long analysis client-side. Costs a second codex run per request.
      const alsoDriver = request.body?.alsoDriver === true && mode !== "driver";

      const segments = listSegmentsForAnalysis(db, request.params.id).map((s) => ({
        clientSeq: s.client_seq,
        text: s.text,
        createdAt: s.created_at,
      }));

      const prepared = preparePrompt(db, request.params.id, session.started_at, segments, mode, instruction);
      const preparedDriver = alsoDriver
        ? preparePrompt(db, request.params.id, session.started_at, segments, "driver", instruction)
        : undefined;

      // Check capacity before writing any DB row so a full queue never leaves an orphaned
      // "queued" analysis behind — reserve room for both runs when fanning out.
      const needed = preparedDriver ? 2 : 1;
      if (queue.pendingCount + needed > queue.maxPendingCount) {
        return reply.code(429).send({ error: "queue_full" });
      }

      const deps = { db, provider, queue, weather };
      let analysisId: string;
      let driverAnalysisId: string | undefined;
      try {
        analysisId = enqueueAnalysis(deps, session.id, mode, prepared, location);
        if (preparedDriver) {
          driverAnalysisId = enqueueAnalysis(deps, session.id, "driver", preparedDriver, location);
        }
      } catch (err) {
        if (err instanceof QueueFullError) {
          return reply.code(429).send({ error: "queue_full" });
        }
        throw err;
      }

      return reply.code(202).send({ analysisId, driverAnalysisId });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/analyses/:id",
    async (request, reply) => {
      const analysis = getAnalysis(db, request.params.id);
      if (!analysis) return reply.code(404).send({ error: "not_found" });
      return reply.send({
        ...analysis,
        result: analysis.result_json ? JSON.parse(analysis.result_json) : null,
      });
    }
  );
}

export { QueueFullError };
