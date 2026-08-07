// ---------------------------------------------------------------------------
// REST routes — session lifecycle
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { ModuleLoader } from '../module-loader.js';
import { SessionManager } from '../session-manager.js';

export function createSessionRoutes(
  loader: ModuleLoader,
  sessions: SessionManager,
) {
  const app = new Hono();

  /** List available games. */
  app.get('/games', async (c) => {
    const games = await loader.listGames();
    return c.json({ games });
  });

  /** Create a new game session. */
  app.post('/', async (c) => {
    const body = await c.req.json<{ gameId: string; players: string[] }>();
    const { gameId, players } = body;

    if (!gameId || !players?.length) {
      return c.json({ error: 'gameId and players[] are required' }, 400);
    }

    try {
      const module = await loader.load(gameId);
      const session = await sessions.createSession(gameId, players, module);

      // Gather initial prompts for the response
      const prompts: Record<string, unknown> = {};
      for (const [pid, prompt] of session.controller.pendingPrompts) {
        prompts[pid] = prompt;
      }

      return c.json({
        sessionId: session.id,
        players: session.players,
        prompts,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  });

  /** Get current game state for a session. */
  app.get('/:sessionId/state', (c) => {
    const session = sessions.getSession(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const state = session.controller.getState();
    return c.json({ state });
  });

  /** Get current pending prompts for a session. */
  app.get('/:sessionId/prompts', (c) => {
    const session = sessions.getSession(c.req.param('sessionId'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const prompts: Record<string, unknown> = {};
    for (const [pid, prompt] of session.controller.pendingPrompts) {
      prompts[pid] = prompt;
    }
    return c.json({ prompts });
  });

  return app;
}
