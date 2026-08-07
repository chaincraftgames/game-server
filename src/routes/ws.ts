// ---------------------------------------------------------------------------
// WebSocket route — game session event transport.
//
// Client connects: ws://host/sessions/:sessionId/ws?playerId=alice
// Server → Client: { type: 'prompt' | 'message' | 'complete', data: ... }
// Client → Server: { type: 'action', data: { actionId, value } }
// ---------------------------------------------------------------------------

import { createNodeWebSocket } from '@hono/node-ws';
import type { Hono } from 'hono';
import { SessionManager } from '../session-manager.js';

export function registerWsRoute(
  app: Hono,
  sessions: SessionManager,
) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: app as any });

  app.get(
    '/sessions/:sessionId/ws',
    upgradeWebSocket((c) => {
      const sessionId = c.req.param('sessionId');
      const playerId = c.req.query('playerId');

      return {
        onOpen(_evt, ws) {
          if (!sessionId || !playerId) {
            ws.send(JSON.stringify({ type: 'error', data: 'sessionId and playerId required' }));
            ws.close(1008, 'Missing params');
            return;
          }
          const session = sessions.getSession(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', data: 'Session not found' }));
            ws.close(1008, 'No session');
            return;
          }
          if (!session.players.includes(playerId)) {
            ws.send(JSON.stringify({ type: 'error', data: 'Player not in session' }));
            ws.close(1008, 'Not a player');
            return;
          }
          sessions.registerSocket(sessionId, playerId, ws);
        },

        async onMessage(evt, ws) {
          if (!sessionId || !playerId) return;
          try {
            const msg = JSON.parse(
              typeof evt.data === 'string' ? evt.data : evt.data.toString(),
            );
            if (msg.type === 'action') {
              const session = sessions.getSession(sessionId);
              if (!session) return;
              await session.controller.processAction({
                playerId,
                ...msg.data,
              });
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : 'Unknown error';
            ws.send(JSON.stringify({ type: 'error', data: errMsg }));
          }
        },

        onClose() {
          if (sessionId && playerId) {
            sessions.removeSocket(sessionId, playerId);
          }
        },
      };
    }),
  );

  return { injectWebSocket };
}
