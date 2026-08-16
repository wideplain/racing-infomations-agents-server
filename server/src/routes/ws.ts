import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import { getSession } from "../db/repo.js";

/**
 * Optional secondary path (see plan): REST batch POST is the primary
 * ingestion route. This WS just echoes session existence / connection
 * status so a future streaming client can attach without server changes.
 */
export function registerWsRoutes(app: FastifyInstance, db: DB): void {
  app.get<{ Params: { id: string } }>(
    "/ws/sessions/:id",
    { websocket: true },
    (socket, request) => {
      const session = getSession(db, request.params.id);
      if (!session) {
        socket.close(1008, "session not found");
        return;
      }
      socket.send(JSON.stringify({ type: "connected", sessionId: session.id }));
      socket.on("message", () => {
        // No-op in Phase 1: ingestion is via REST batch POST.
      });
    }
  );
}
