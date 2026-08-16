import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { AIProvider } from "../ai/types.js";
import type { WeatherProvider } from "../weather/types.js";
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

function serializeResult(mode: AnalyzeMode, result: Awaited<ReturnType<AIProvider["analyze"]>>): string {
  if (mode === "pitwall") return JSON.stringify(parsePitwallAnalysis(result.rawOutput));
  if (mode === "driver") return JSON.stringify(parseDriverAnalysis(result.rawOutput));
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
            if (result?.summaryText) weatherText = result.summaryText;
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
          result_json: serializeResult(mode, result),
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

export function registerAnalyzeRoutes(
  app: FastifyInstance,
  db: DB,
  provider: AIProvider,
  queue: SerialQueue,
  weather: WeatherProvider
): void {
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
