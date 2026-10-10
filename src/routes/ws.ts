// ---------------------------------------------------------------------------
// WebSocket route — game session event transport.
//
// Client connects: ws://host/sessions/:sessionId/ws?playerId=alice
// Server → Client: ServerMessage (see ws-types.ts)
// Client → Server: ClientMessage (Zod-validated, see ws-types.ts)
// ---------------------------------------------------------------------------

import { createNodeWebSocket } from "@hono/node-ws";
import type { Hono } from "hono";
import { SessionManager, toErrorPayload } from "#chaincraft/session-manager.js";
import {
  ClientMessageSchema,
  GameErrorServerMessage,
} from "#chaincraft/api-types.js";
import type { ErrorPayload } from "#chaincraft/api-types.js";
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
      // Messages can arrive before a rejected socket finishes closing.
      let authenticated = false;

      return {
        async onOpen(_evt, wsContext) {
          if (!sessionId || !playerId || !playerToken) {
            sendError(wsContext, {
              code: "invalid-request",
              message: "sessionId, playerId and playerToken required",
            });
            wsContext.close(1008, "Missing params");
            return;
          }
          let session;
          try {
            session = sessions.authenticate(sessionId, playerId, playerToken);
          } catch (e) {
            sendError(wsContext, toErrorPayload(e, "internal-error"));
            wsContext.close(1008, "Not authorized");
            return;
          }
          authenticated = true;
          try {
            await sessions.connect(session, playerId, wsContext);
          } catch (e) {
            console.error("WS connect failed", e);
            sendError(wsContext, toErrorPayload(e, "internal-error"));
          }
        },

        async onMessage(evt, wsContext) {
          if (!sessionId || !playerId) return;
          if (!authenticated) {
            sendError(wsContext, {
              code: "unauthorized",
              message: "Not authenticated",
            });
            return;
          }
          try {
            const raw = JSON.parse(
              typeof evt.data === "string" ? evt.data : evt.data.toString(),
            );

            // Validate incoming message against the schema
            const parsed = ClientMessageSchema.safeParse(raw);
            if (!parsed.success) {
              sendError(wsContext, {
                code: "invalid-request",
                message: `Invalid message: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
              });
              return;
            }

            const msg = parsed.data;
            switch (msg.type) {
              case "player-status-update":
                await sessions.updatePlayerStatus(
                  sessionId,
                  playerId,
                  msg.data.status,
                );
                break;
              case "prompt-response":
                await sessions.submitPromptResponse(
                  sessionId,
                  playerId,
                  msg.data.promptId,
                  msg.data.value,
                );
                break;
              default:
                msg satisfies never;
            }
          } catch (e) {
            // Runtime input rejections are plain Errors until WS3 adds illegal-action.
            sendError(wsContext, toErrorPayload(e, "invalid-request"));
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

function sendError(ws: WSContext, error: ErrorPayload) {
  ws.send(
    JSON.stringify({
      type: "error",
      data: error,
    } satisfies GameErrorServerMessage),
  );
}
