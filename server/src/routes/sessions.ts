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
  insertLocations,
  listLocations,
} from "../db/repo.js";
import type { RouteResolver } from "../route/routeResolver.js";

const ROUTE_LOCATIONS_LIMIT = 5000;

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

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).optional(),
  speedMps: z.number().optional(),
  bearingDeg: z.number().min(0).max(360).optional(),
  recordedAt: z.string(),
});

const locationsBatchSchema = z.object({
  locations: z.array(locationSchema).min(1).max(50),
});

const segmentPatchSchema = z.object({
  text: z.string().min(1).optional(),
  excluded: z.boolean().optional(),
});

export function registerSessionRoutes(
  app: FastifyInstance,
  db: DB,
  routeResolver: RouteResolver
): void {
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

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/locations",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });

      const parsed = locationsBatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const { inserted } = insertLocations(
        db,
        request.params.id,
        parsed.data.locations
      );
      return reply.code(201).send({ inserted });
    }
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
    "/sessions/:id/locations",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });

      const afterId = Number(request.query.after);
      const limit = Number(request.query.limit);
      const locations = listLocations(db, request.params.id, {
        afterId: Number.isFinite(afterId) && afterId > 0 ? afterId : 0,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 500,
      });
      return reply.send({ locations });
    }
  );

  // AI不使用: セッションのGPS軌跡を国土地理院リバースジオコーダで地名化した通過地点リスト。
  // 外部API保護のため呼び出しはビュワーの手動更新のみ(自動ポーリング対象外)。
  app.get<{ Params: { id: string } }>(
    "/sessions/:id/route",
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const locations = listLocations(db, request.params.id, {
        limit: ROUTE_LOCATIONS_LIMIT,
      });
      const route = await routeResolver.resolveRoute(locations);
      return reply.send({ route, pointCount: locations.length });
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
