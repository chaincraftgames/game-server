// ---------------------------------------------------------------------------
// REST routes — session lifecycle
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ModuleLoader } from "../module-loader.js";
import {
  SessionManager,
  SessionError,
  toErrorPayload,
} from "#chaincraft/session-manager.js";
import type { HostedSession } from "#chaincraft/session-manager.js";
import {
  JoinSessionRequestSchema,
  QueryRequestSchema,
  ServerErrorResponse,
} from "#chaincraft/api-types.js";
import type {
  CreateSessionRequest,
  JoinSessionResponse,
  QueryResponse,
  SessionErrorType,
} from "#chaincraft/api-types.js";

function httpStatusFor(code: SessionErrorType): ContentfulStatusCode {
  switch (code) {
    case "session-not-found":
    case "game-not-found":
      return 404;
    case "unauthorized":
      return 401;
    case "internal-error":
      return 500;
    default:
      return 400;
  }
}

export function createSessionRoutes(
  loader: ModuleLoader,
  sessions: SessionManager,
) {
  const app = new Hono();

  app.onError((e, c) => {
    const payload = toErrorPayload(e, "internal-error");
    if (payload.code === "internal-error")
      console.error("REST request failed", e);
    return c.json(
      { error: payload } satisfies ServerErrorResponse,
      httpStatusFor(payload.code),
    );
  });

  // ---------------------------------------------------------------------------
  // REST route: GET /games — List available games.
  // ---------------------------------------------------------------------------
  app.get("/games", async (c) => {
    const games = await loader.listGames();
    return c.json({ games });
  });

  // ---------------------------------------------------------------------------
  // REST route: POST / - Create a new game session.
  // ---------------------------------------------------------------------------
  app.post("/:gameId/session", async (c) => {
    const body = await c.req.json<CreateSessionRequest>();
    const { gameId } = c.req.param();

    // Allowlist check also keeps gameId from reaching the loader's file path unvetted.
    if (!(await loader.listGames()).includes(gameId)) {
      throw new SessionError("game-not-found", `Game "${gameId}" not found`);
    }
    const module = await loader.load(gameId);
    const session = await sessions.createSession(gameId, module);

    return c.json({
      sessionId: session.id,
      joinCode: session.joinCode,
    });
  });

  // ---------------------------------------------------------------------------
  // REST route: POST /:sessionId/join — Join a session, returns player token.
  // ---------------------------------------------------------------------------
  app.post("/:sessionId/join", async (c) => {
    const { sessionId } = c.req.param();
    const body = await c.req.json().catch(() => {
      throw new SessionError("invalid-request", "Malformed JSON body");
    });
    const parsed = JoinSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new SessionError(
        "invalid-request",
        parsed.error.issues.map((i) => i.message).join(", "),
      );
    }
    const { playerId, joinCode } = parsed.data;
    const session = sessions.getSession(sessionId);
    if (!session)
      throw new SessionError("session-not-found", "Session not found");
    const token = await sessions.join(session, joinCode, playerId);
    return c.json({ token } satisfies JoinSessionResponse);
  });

  /** Resolves `Authorization: Bearer <player token>` to the session and player. */
  const requirePlayer = createMiddleware<{
    Variables: { session: HostedSession; playerId: string };
  }>(async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";
    if (!token)
      throw new SessionError("unauthorized", "Bearer player token required");
    const { session, playerId } = sessions.authenticateToken(
      c.req.param("sessionId") ?? "",
      token,
    );
    c.set("session", session);
    c.set("playerId", playerId);
    await next();
  });

  // ---------------------------------------------------------------------------
  // REST route: POST /:sessionId/query — What would each response sequence lead to?
  // ---------------------------------------------------------------------------
  app.post("/:sessionId/query", requirePlayer, async (c) => {
    const body = await c.req.json().catch(() => {
      throw new SessionError("invalid-request", "Malformed JSON body");
    });
    const parsed = QueryRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new SessionError(
        "invalid-request",
        parsed.error.issues.map((i) => i.message).join(", "),
      );
    }
    const results = await sessions.queryResponses(
      c.get("session"),
      c.get("playerId"),
      parsed.data.promptId,
      parsed.data.queries.map((q) => q.responses),
    );
    return c.json({ results } satisfies QueryResponse);
  });

  return app;
}
