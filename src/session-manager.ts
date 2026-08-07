// ---------------------------------------------------------------------------
// SessionManager — in-memory session lifecycle.
//
// Holds a Map<sessionId, ManagedSession>. Each session owns a GameController
// and a set of connected WebSocket clients. Wires GameController events to
// push messages over the player's socket.
// ---------------------------------------------------------------------------

import { GameController } from '@chaincraft/runtime';
import type { CompiledGameModule, Message } from '@chaincraft/runtime';
import type { PlayerInputSuspension, GameOutcome } from '@chaincraft/runtime';
import type { WSContext } from 'hono/ws';

export interface ManagedSession {
  id: string;
  gameId: string;
  controller: GameController;
  players: string[];
  sockets: Map<string, WSContext>;
}

let counter = 0;

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();

  async createSession(
    gameId: string,
    players: string[],
    module: CompiledGameModule,
  ): Promise<ManagedSession> {
    const sessionId = `${gameId}-${++counter}`;
    const controller = new GameController(module, {
      events: {
        onPrompt: (prompt) => this.pushToAwaitedPlayers(sessionId, prompt),
        onMessage: (message) =>
          this.broadcast(sessionId, { type: 'message', data: message }),
        onComplete: (outcome) =>
          this.broadcast(sessionId, { type: 'complete', data: outcome }),
      },
    });

    const session: ManagedSession = {
      id: sessionId,
      gameId,
      controller,
      players,
      sockets: new Map(),
    };
    this.sessions.set(sessionId, session);

    await controller.init(sessionId, players);
    return session;
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Register a WebSocket for a player and send any pending prompt. */
  registerSocket(sessionId: string, playerId: string, ws: WSContext): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.sockets.set(playerId, ws);

    // If a prompt is already pending for this player, push it immediately (reconnect support)
    const prompt = session.controller.pendingPrompts.get(playerId);
    if (prompt) {
      ws.send(JSON.stringify({ type: 'prompt', data: prompt }));
    }
  }

  removeSocket(sessionId: string, playerId: string): void {
    this.sessions.get(sessionId)?.sockets.delete(playerId);
  }

  // ---------------------------------------------------------------------------
  // Internal push helpers
  // ---------------------------------------------------------------------------

  private pushToAwaitedPlayers(
    sessionId: string,
    prompt: PlayerInputSuspension,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const playerId of prompt.awaiting) {
      const ws = session.sockets.get(playerId);
      if (ws) ws.send(JSON.stringify({ type: 'prompt', data: prompt }));
    }
  }

  private broadcast(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const payload = JSON.stringify(message);
    for (const ws of session.sockets.values()) {
      ws.send(payload);
    }
  }
}
