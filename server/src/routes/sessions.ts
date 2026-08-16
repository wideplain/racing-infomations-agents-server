import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db/index.js";
import {
  createSession,
  endSession,
  getSession,
  listSessions,
  insertSegments,
  listSegments,
  updateSegment,
  listAnalysesForSession,
} from "../db/repo.js";

const createSessionSchema = z.object({
  title: z.string().optional(),
  deviceId: z.string().optional(),
});

const segmentSchema = z.object({
  clientSeq: z.number().int(),
  text: z.string(),
  isFinal: z.boolean().optional(),
});

const segmentsBatchSchema = z.object({
  segments: z.array(segmentSchema).min(1),
});

const segmentPatchSchema = z.object({
  text: z.string().min(1).optional(),
  excluded: z.boolean().optional(),
});

export function registerSessionRoutes(app: FastifyInstance, db: DB): void {
  app.post("/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const session = createSession(db, parsed.data);
    return reply.code(201).send(session);
  });

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/end",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const updated = endSession(db, request.params.id);
      return reply.send(updated);
    }
  );

  app.get("/sessions", async () => {
    return listSessions(db);
  });

  app.get<{ Params: { id: string } }>(
    "/sessions/:id",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const segments = listSegments(db, request.params.id);
      return reply.send({ ...session, segments });
    }
  );

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/segments",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });

      const parsed = segmentsBatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const { inserted } = insertSegments(
        db,
        request.params.id,
        parsed.data.segments
      );
      return reply.code(201).send({ inserted });
    }
  );

  // Read-only viewer support: the whole analysis timeline for a session (both modes, all
  // statuses), independent of the app's local manual/auto distinction which never reaches
  // the server.
  app.get<{ Params: { id: string } }>(
    "/sessions/:id/analyses",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const analyses = listAnalysesForSession(db, request.params.id).map((a) => ({
        ...a,
        result: a.result_json ? JSON.parse(a.result_json) : null,
      }));
      return reply.send(analyses);
    }
  );

  app.patch<{ Params: { id: string; clientSeq: string } }>(
    "/sessions/:id/segments/:clientSeq",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });

      const clientSeq = Number(request.params.clientSeq);
      if (!Number.isInteger(clientSeq)) {
        return reply.code(400).send({ error: "invalid_client_seq" });
      }
      const parsed = segmentPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const updated = updateSegment(db, request.params.id, clientSeq, parsed.data);
      if (!updated) return reply.code(404).send({ error: "segment_not_found" });
      return reply.send(updated);
    }
  );
}
