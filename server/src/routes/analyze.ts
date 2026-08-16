import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import type { AIProvider } from "../ai/types.js";
import { SerialQueue, QueueFullError } from "../analysis/queue.js";
import { buildPrompt, buildPitwallPrompt, type PitwallDecision } from "../analysis/prompt.js";
import { parsePitwallAnalysis } from "../analysis/parse.js";
import { PITWALL_SCHEMA_PATH } from "../ai/codexProvider.js";
import {
  getSession,
  listSegmentsForAnalysis,
  createAnalysis,
  getAnalysis,
  updateAnalysis,
  listRecentAnalyses,
} from "../db/repo.js";

type AnalyzeMode = "default" | "pitwall";

function isAnalyzeMode(value: unknown): value is AnalyzeMode {
  return value === "default" || value === "pitwall";
}

export function registerAnalyzeRoutes(
  app: FastifyInstance,
  db: DB,
  provider: AIProvider,
  queue: SerialQueue
): void {
  app.post<{
    Params: { id: string };
    Body: { mode?: string; instruction?: string } | undefined;
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

      const segments = listSegmentsForAnalysis(db, request.params.id).map((s) => ({
        clientSeq: s.client_seq,
        text: s.text,
        createdAt: s.created_at,
      }));

      let prompt: string;
      let schemaPath: string | undefined;
      if (mode === "pitwall") {
        const priorAnalyses = listRecentAnalyses(db, request.params.id, {
          mode: "pitwall",
          status: "done",
          limit: 5,
        });
        const decisions: PitwallDecision[] = priorAnalyses.map((a) => {
          const parsed = a.result_json ? JSON.parse(a.result_json) : {};
          return {
            createdAt: a.created_at,
            proposal: parsed.proposal ?? "",
            statusSummary: parsed.statusSummary ?? "",
          };
        });
        prompt = buildPitwallPrompt(segments, session.started_at, decisions, { instruction });
        schemaPath = PITWALL_SCHEMA_PATH;
      } else {
        prompt = buildPrompt(segments, session.started_at, { instruction });
      }

      // Check capacity before writing a DB row so a full queue never leaves
      // an orphaned "queued" analysis behind.
      if (queue.pendingCount >= queue.maxPendingCount) {
        return reply.code(429).send({ error: "queue_full" });
      }

      let analysisId: string;
      try {
        const analysis = createAnalysis(db, {
          sessionId: session.id,
          provider: provider.name,
          prompt,
          mode,
        });
        analysisId = analysis.id;
        queue
          .enqueue(async () => {
            updateAnalysis(db, analysis.id, { status: "running" });
            try {
              const result = await provider.analyze({ prompt, schemaPath });
              const resultJson =
                mode === "pitwall"
                  ? JSON.stringify(parsePitwallAnalysis(result.rawOutput))
                  : JSON.stringify({
                      summary: result.summary,
                      interpretation: result.interpretation,
                      advice: result.advice,
                      suggested_response: result.suggested_response,
                      confidence: result.confidence,
                      notes: result.notes,
                      parseFallback: result.parseFallback,
                    });
              updateAnalysis(db, analysis.id, {
                status: "done",
                raw_output: result.rawOutput,
                result_json: resultJson,
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
      } catch (err) {
        if (err instanceof QueueFullError) {
          return reply.code(429).send({ error: "queue_full" });
        }
        throw err;
      }

      return reply.code(202).send({ analysisId });
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
