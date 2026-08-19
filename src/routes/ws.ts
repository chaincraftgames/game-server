// ---------------------------------------------------------------------------
// WebSocket route — game session event transport.
//
// Client connects: ws://host/sessions/:sessionId/ws?playerId=alice
// Server → Client: ServerMessage (see ws-types.ts)
// Client → Server: ClientMessage (Zod-validated, see ws-types.ts)
// ---------------------------------------------------------------------------

import { createNodeWebSocket } from "@hono/node-ws";
import type { Hono } from "hono";
import { SessionManager, SessionError } from "#chaincraft/session-manager.js";
import { ClientMessageSchema, GameErrorServerMessage } from "#chaincraft/api-types.js";
import type { SessionErrorType } from "#chaincraft/api-types.js";
import { WSContext } from "hono/ws";

/** Register the WebSocket route for game session events. */
export function registerWsRoute(app: Hono, sessions: SessionManager) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
    app: app as any,
  });

  // ---------------------------------------------------------------------------
  // WebSocket route: /sessions/:sessionId/ws
  // ---------------------------------------------------------------------------
  app.get(
    "/sessions/:sessionId/ws",
    upgradeWebSocket((wsContext) => {
      const sessionId = wsContext.req.param("sessionId");
      const playerId = wsContext.req.query("playerId");
      const playerToken = wsContext.req.query("playerToken");

      return {
        onOpen(_evt, wsContext) {
          if (!sessionId || !playerId || !playerToken) {
            sendError(wsContext, "invalid-request", "sessionId, playerId and playerToken required");
            wsContext.close(1008, "Missing params");
            return;
          }
          const session = sessions.getSession(sessionId);
          if (!session) {
            sendError(wsContext, "session-not-found", "Session not found");
            wsContext.close(1008, "No session");
            return;
          }
          if (!session.players.has(playerId)) {
            sendError(wsContext, "player-not-joined", "Player not in session");
            wsContext.close(1008, "Not a player");
            return;
          }
          sessions.connect(sessionId, playerId, playerToken,wsContext);
        },

        async onMessage(evt, wsContext) {
          if (!sessionId || !playerId) return;
          try {
            const raw = JSON.parse(
              typeof evt.data === "string" ? evt.data : evt.data.toString(),
            );

            // Validate incoming message against the schema
            const parsed = ClientMessageSchema.safeParse(raw);
            if (!parsed.success) {
              sendError(
                wsContext,
                "invalid-request",
                `Invalid message: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
              );
              return;
            }

            const msg = parsed.data;
            switch (msg.type) {
              case "player-status-update":
                sessions.updatePlayerStatus(sessionId, playerId, msg.data.status);
                break;  
              case "prompt-response":
                const session = sessions.getSession(sessionId);
                if (!session) return;
                await session.controller.processAction({
                  playerId,
                  value: msg.data.value,
                });
                break;
              default:
                msg satisfies never;
            }
          } catch (e) {
            if (e instanceof SessionError) {
              sendError(wsContext, e.errorType, e.message);
            } else {
              sendError(wsContext, "invalid-request", e instanceof Error ? e.message : "Unknown error");
            }
          }
        },

        onClose() {
          if (sessionId && playerId) {
            sessions.disconnect(sessionId, playerId);
          }
        },
      };
    }),
  );

  return { injectWebSocket };
}

function sendError(ws: WSContext, code: SessionErrorType, message: string) {
  ws.send(
    JSON.stringify({
      type: "error",
      data: { code, message },
    } satisfies GameErrorServerMessage),
  );
}
