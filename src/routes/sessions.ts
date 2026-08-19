// ---------------------------------------------------------------------------
// REST routes — session lifecycle
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { ModuleLoader } from '../module-loader.js';
import { SessionManager, SessionError } from '../session-manager.js';
import {
  JoinSessionRequestSchema,
  ServerErrorResponse,
} from '#chaincraft/api-types.js';
import type { 
  CreateSessionRequest, 
  JoinSessionResponse 
} from '#chaincraft/api-types.js';

export function createSessionRoutes(
  loader: ModuleLoader,
  sessions: SessionManager,
) {
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // REST route: GET /games — List available games.
  // ---------------------------------------------------------------------------
  app.get('/games', async (c) => {
    const games = await loader.listGames();
    return c.json({ games });
  });

  // ---------------------------------------------------------------------------
  // REST route: POST / - Create a new game session.
  // ---------------------------------------------------------------------------
  app.post('/:gameId/session', async (c) => {
    const body = await c.req.json<CreateSessionRequest>();
    const { gameId } = c.req.param();

    try {
      const module = await loader.load(gameId);
      const session = await sessions.createSession(gameId, module);

      return c.json({
        sessionId: session.id,
        joinCode: session.joinCode,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // REST route: POST /:sessionId/join — Join a session, returns player token.
  // ---------------------------------------------------------------------------
  app.post('/:sessionId/join', async (c) => {
    const { sessionId } = c.req.param();
    const body = await c.req.json();
    const parsed = JoinSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(', ') } satisfies ServerErrorResponse,
        400,
      );
    }
    const { playerId, joinCode } = parsed.data;
    const session = sessions.getSession(sessionId);
    if (!session)
      return c.json({ error: 'Session not found' } satisfies ServerErrorResponse, 404);
    try {
      const token = sessions.join(session, joinCode, playerId);
      return c.json({ token } satisfies JoinSessionResponse);
    } catch (e) {
      if (e instanceof SessionError)
        return c.json({ error: e.message } satisfies ServerErrorResponse, 400);
      return c.json({ error: 'Unknown error' } satisfies ServerErrorResponse, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // REST route: GET /:sessionId/state — Get current game state for a session.
  // ---------------------------------------------------------------------------
  app.get('/:sessionId/state', (c) => {
    const session = sessions.getSession(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' } satisfies ServerErrorResponse, 404);
    if (!session.controller.isInitialized) return c.json({ state: null });
    const state = session.controller.getState();
    return c.json({ state });
  });

  // ---------------------------------------------------------------------------
  // REST route: GET /:sessionId/prompts — Get current pending prompts for a session.
  // ---------------------------------------------------------------------------
  app.get('/:sessionId/prompts', (c) => {
    const session = sessions.getSession(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' } satisfies ServerErrorResponse, 404);
    const prompts: Record<string, unknown> = {};
    for (const [pid, prompt] of session.controller.pendingPrompts) {
      prompts[pid] = prompt;
    }
    return c.json({ prompts });
  });

  return app;
}
