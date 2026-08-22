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
  buildQuestionPrompt,
  transcriptStamps,
  type PitwallDecision,
  type PriorRecord,
} from "../analysis/prompt.js";
import {
  parsePitwallAnalysis,
  parseDriverAnalysis,
  parseQuestionAnalysis,
} from "../analysis/parse.js";
import {
  PITWALL_SCHEMA_PATH,
  DRIVER_SCHEMA_PATH,
  QUESTION_SCHEMA_PATH,
} from "../ai/codexProvider.js";
import {
  getSession,
  listSegmentsForAnalysis,
  createAnalysis,
  getAnalysis,
  updateAnalysis,
  listRecentAnalyses,
  getLatestLocation,
  getPitLocation,
  getLatestWeatherSnapshot,
} from "../db/repo.js";

const WEATHER_LOCATION_MAX_AGE_MS = 10 * 60 * 1000;

interface WeatherLocation {
  lat: number;
  lng: number;
  recorded_at: string;
}

function isFreshLocation(location: WeatherLocation | undefined): location is WeatherLocation {
  if (!location) return false;
  const ageMs = Date.now() - new Date(location.recorded_at).getTime();
  return Number.isFinite(ageMs) && ageMs <= WEATHER_LOCATION_MAX_AGE_MS;
}

/** The pit crew's own screen (see /sessions/:id/pit-location) is a better weather location than
 * the car's GPS track — the crew cares about conditions where they are standing, not wherever
 * the car happens to be on a lap. Fall back to the car's latest fix if the pit hasn't reported
 * one (e.g. an older session, or the pit page never opened). */
function resolveWeatherLocation(
  db: DB,
  sessionId: string
): { location: WeatherLocation | undefined; hasAnyLocation: boolean } {
  const pit = getPitLocation(db, sessionId);
  if (isFreshLocation(pit)) return { location: pit, hasAnyLocation: true };
  const car = getLatestLocation(db, sessionId);
  if (isFreshLocation(car)) return { location: car, hasAnyLocation: true };
  return { location: undefined, hasAnyLocation: Boolean(pit || car) };
}

type AnalyzeMode = "default" | "pitwall" | "driver" | "question";

function isAnalyzeMode(value: unknown): value is AnalyzeMode {
  return (
    value === "default" || value === "pitwall" || value === "driver" || value === "question"
  );
}

interface PreparedPrompt {
  prompt: string;
  schemaPath?: string;
  /** Question mode only: the crew's question, kept so the stored result can carry it. */
  question?: string;
  /** Question mode only: the [mm:ss] stamps this prompt actually showed the model, so a cited
   * one can be checked against a line that exists rather than merely arithmetically resolved. */
  transcriptStamps?: ReadonlySet<string>;
}

interface PromptSegmentInput {
  clientSeq: number;
  text: string;
  createdAt: string;
}

/** Builds the prompt + schema for one mode. Prior analyses of the *same* mode are fed back in as
 * "these are the notes so far" context, so each mode's history stays self-consistent. Question
 * mode is the exception — see its branch below. */
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
  if (mode === "question") {
    // The one mode that does not feed on its own history alone. A crew member asking "さっき
    // 出ていた提案の件だけど" is following up on something a pitwall run said, and a context built
    // only from past questions and answers can never reach it.
    const records: PriorRecord[] = [
      ...listRecentAnalyses(db, sessionId, { mode: "pitwall", status: "done", limit: 5 }).map(
        (a) => {
          const parsed = a.result_json ? JSON.parse(a.result_json) : {};
          return {
            createdAt: a.created_at,
            label: "ピットウォール",
            text: `状況: ${parsed.statusSummary ?? ""} / 提案: ${parsed.proposal ?? ""}`,
          };
        }
      ),
      ...listRecentAnalyses(db, sessionId, { mode: "question", status: "done", limit: 5 }).map(
        (a) => {
          const parsed = a.result_json ? JSON.parse(a.result_json) : {};
          return {
            createdAt: a.created_at,
            label: "質問",
            text: `Q: ${parsed.asked ?? ""} / A: ${parsed.answer ?? ""}`,
          };
        }
      ),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const question = (instruction ?? "").trim();
    const prompt = buildQuestionPrompt(segments, sessionStartedAt, records, { question });
    return {
      prompt,
      schemaPath: QUESTION_SCHEMA_PATH,
      question,
      transcriptStamps: transcriptStamps(prompt),
    };
  }
  return { prompt: buildPrompt(segments, sessionStartedAt, { instruction }) };
}

function serializeResult(
  mode: AnalyzeMode,
  result: Awaited<ReturnType<AIProvider["analyze"]>>,
  context: {
    sessionStartedAt: string;
    question?: string;
    transcriptStamps?: ReadonlySet<string>;
  },
  rainForecast?: RainForecast,
  weatherForecast?: WeatherForecast
): string {
  if (mode === "pitwall") return JSON.stringify(parsePitwallAnalysis(result.rawOutput));
  if (mode === "question") {
    // The question itself is stored alongside the answer rather than left in the prompt column:
    // the viewer shows a timeline of results to someone who never saw the request, and an answer
    // with no visible question is unreadable there. It also lets a later question's context show
    // what was already asked.
    return JSON.stringify({
      asked: context.question ?? "",
      ...parseQuestionAnalysis(
        result.rawOutput,
        context.sessionStartedAt,
        context.transcriptStamps ?? new Set()
      ),
    });
  }
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
  sessionStartedAt: string,
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
          const resolved = resolveWeatherLocation(db, sessionId);
          if (resolved.location) {
            weatherLocation = { lat: resolved.location.lat, lng: resolved.location.lng };
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
          result_json: serializeResult(
            mode,
            result,
            {
              sessionStartedAt,
              question: prepared.question,
              transcriptStamps: prepared.transcriptStamps,
            },
            rainForecast,
            weatherForecast
          ),
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

      const resolved = resolveWeatherLocation(db, session.id);
      if (!resolved.location) {
        return reply.send({
          weather: null,
          snapshot: storedSnapshot,
          precipitation: null,
          reason: resolved.hasAnyLocation ? "location_stale" : "location_unavailable",
        });
      }
      const location = resolved.location;

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
      const resolved = resolveWeatherLocation(db, session.id);
      if (!resolved.location) {
        return reply.send({
          timeline: null,
          precipitation: null,
          reason: resolved.hasAnyLocation ? "location_stale" : "location_unavailable",
        });
      }
      const location = resolved.location;
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
      // In the reporting modes an instruction is an optional aside; in question mode it carries
      // the question, so an empty one has nothing to answer. Rejecting it here costs the caller a
      // fast 400 instead of a two-minute codex run that returns "記録にありません" to no question.
      if (mode === "question" && !instruction?.trim()) {
        return reply.code(400).send({ error: "question_required" });
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
      // Never fans out for question mode: the crew is sitting there waiting on an answer, and the
      // queue is serial, so a second codex run would put a HUD brief nobody asked for in front of
      // the thing they did ask for.
      const alsoDriver =
        request.body?.alsoDriver === true && mode !== "driver" && mode !== "question";

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
        analysisId = enqueueAnalysis(deps, session.id, session.started_at, mode, prepared, location);
        if (preparedDriver) {
          driverAnalysisId = enqueueAnalysis(
            deps,
            session.id,
            session.started_at,
            "driver",
            preparedDriver,
            location
          );
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
