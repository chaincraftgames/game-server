// ---------------------------------------------------------------------------
// SessionManager — in-memory session lifecycle.
//
// Holds a Map<sessionId, ManagedSession>. Each session owns a GameController
// and a set of connected WebSocket clients. Wires GameController events to
// push messages over the player's socket.
// ---------------------------------------------------------------------------

import { 
  GameController, 
} from "@chaincraft/runtime";
import type {
  CompiledGameModule,
  Message,
  PlayerCount,
} from "@chaincraft/runtime";
import type { PlayerInputSuspension, GameOutcome } from "@chaincraft/runtime";
import type { WSContext } from "hono/ws";
import {
  GameCompleteServerMessage,
  GameErrorServerMessage,
  GameMessageServerMessage,
  PlayerStatusUpdateMessage,
  PromptServerMessage,
  StateChangeServerMessage,
  SyncServerMessage,
} from "./api-types.js";
import type { SessionErrorType, StateChangeEvent } from "./api-types.js";

/** Information about a player in a session. */
interface PlayerInfo {
  /** The id of the player as reported by the player when joining. */
  id: string;
  /** The current state of the player in the session. */
  playerState: "joined" | "ready" | "playing" | "left";
  /** A token that can be used to authenticate the player in future requests. */
  token: string;
  /** A queue of undelivered messages for the player. */
  messageQueue: Message[];
  /** Per-recipient counter for messages addressed to this player. */
  messageSeq: number;
  /** Per-viewer counter for state-change frames delivered to this player. */
  stateChangeSeq: number;
}

export class SessionError extends Error {
  constructor(public readonly errorType: SessionErrorType, message?: string) {
    super(message ?? errorType);
    this.name = "SessionError";
  }
}

/**
 * Represents a game in progress hosted by the server.  This has a different shape than
 * the GameSession type in the runtime, as it includes server-specific information such as
 * the join code and connected WebSocket clients.
 */
export interface HostedSession {
  suppressPromptPushes?: boolean;
  /** The id of the session.  Used to make session-specific requests. */
  id: string;
  /**
   * The id of the game being played. This is the same across all sessions of this
   * game.
   */
  gameId: string;
  /** How many players the game supports. */
  playerCount: PlayerCount;
  /** The join code for the session. */
  joinCode: string;
  /** The game controller associated with this session. */
  controller: GameController;
  /** The players in the session, keyed by player ID. */
  players: Map<string, PlayerInfo>;
  /** Maps player tokens to player IDs. */
  playerTokenIndex: Map<string, string>;
  /** The WebSocket connections for each player, keyed by player ID. */
  sockets: Map<string, WSContext>;
}

/**
 * SessionManager — manages the lifecycle of GameSessions. Creates sessions,
 * registers sockets, and routes events to the appropriate players.
 */
export class SessionManager {
  private sessions = new Map<string, HostedSession>();

  /** Create a new session for the given game and players. */
  async createSession(
    gameId: string,
    module: CompiledGameModule,
  ): Promise<HostedSession> {
    const sessionId = this.createSessionId(gameId);
    const playerCount = module.metadata.playerCount;
    const controller = new GameController(module, {
      events: {
        onPrompt: (prompt) => this.pushPromptToAwaitedPlayers(sessionId, prompt),
        onMessage: (message) => this.pushGameMessageToRecipients(sessionId, message),
        onComplete: (outcome) =>
          this.broadcast(sessionId, {
            type: "complete",
            data: outcome,
          } satisfies GameCompleteServerMessage),
        onStateChange: (changes) => this.pushStateChanges(sessionId, changes),
      },
    });

    const session: HostedSession = {
      id: sessionId,
      gameId,
      playerCount,
      controller,
      joinCode: this.createJoinCode(),
      playerTokenIndex: new Map(),
      players: new Map(),
      sockets: new Map(),
    };
    this.sessions.set(sessionId, session);

    // await controller.init(sessionId, players);
    return session;
  }

  /** Get the session associated with the given session ID, if it exists. */
  getSession(sessionId: string): HostedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Remove the session associated with the given session ID. */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Register a WebSocket for a player and send any pending prompt. */
  connect(
    sessionId: string,
    playerId: string,
    playerToken: string,
    ws: WSContext,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Confirm the player token matches the player ID.
    const expectedToken = session.playerTokenIndex.get(playerId);
    if (expectedToken !== playerToken) {
      ws.send(
        JSON.stringify({
          type: "error",
          data: { code: "invalid-request", message: "Invalid player token" },
        } satisfies GameErrorServerMessage),
      );
      ws.close(1008, "Invalid player token");
      return;
    }
    session.sockets.set(playerId, ws);

    // Before init(), the controller has no state — send empty sync.
    const initialized = session.controller.isInitialized;
    const projectedState = initialized
      ? session.controller.projectStateForPlayer(playerId)
      : undefined;
    const prompt = initialized
      ? session.controller.pendingPrompts.get(playerId)
      : undefined;
    const playerInfo = session.players.get(playerId);
    const queuedMessages = playerInfo?.messageQueue ?? [];

    // Send the sync message to the player.
    ws.send(
      JSON.stringify({
        type: "sync",
        data: {
          gameState: projectedState,
          prompt,
          messages: queuedMessages,
          stateChangeSeq: playerInfo?.stateChangeSeq ?? 0,
          messageSeq: playerInfo?.messageSeq ?? 0,
        },
      } satisfies SyncServerMessage),
    );

    // Clear the queued messages for the player.
    if (playerInfo) {
      playerInfo.messageQueue = [];
    }
  }

  /** Remove the WebSocket associated with the given player in the specified session. */
  disconnect(sessionId: string, playerId: string): void {
    this.sessions.get(sessionId)?.sockets.delete(playerId);
  }

  /**
   * Join the player to the session. The join code provided by the player must match
   * the join code of the session. If the player is already in the session, an error is thrown.
   */
  join(session: HostedSession, joinCode: string, playerId: string): string {
    if (session.playerTokenIndex.has(playerId))
      throw new SessionError("player-already-joined");
    if (session.joinCode !== joinCode)
      throw new SessionError("join-code-not-found");
    if (session.players.size >= session.playerCount.max)
      throw new SessionError("no-available-player-slots");

    const token = this.createPlayerToken();
    session.playerTokenIndex.set(playerId, token);
    const playerInfo: PlayerInfo = {
      id: playerId,
      playerState: "joined",
      token,
      messageQueue: [],
      messageSeq: 0,
      stateChangeSeq: 0,
    };
    session.players.set(playerId, playerInfo);
    this.broadcast(session.id, {
      type: "player-status-update",
      data: {
        id: playerId,
        status: "joined",
      },
    } satisfies PlayerStatusUpdateMessage);
    return token;
  }

  async updatePlayerStatus(
    sessionId: string,
    playerId: string,
    status: "joined" | "ready" | "playing" | "left",
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionError("session-not-found");
    const playerInfo = session.players.get(playerId);
    if (!playerInfo) throw new SessionError("player-not-joined");
    switch (status) {
      case "joined":
        throw new SessionError("invalid-message", `Cannot update player status to "joined"`);
      case "ready":
        await this.handlePlayerReady(session, playerInfo!);
        break;
      case "playing":
      case "left":
        break;
      default:
        throw new Error(`Invalid player status: ${status}`);
    }
    playerInfo!.playerState = status;
    this.broadcast(sessionId, {
      type: "player-status-update",
      data: {
        id: playerId,
        status: status,
      },
    } satisfies PlayerStatusUpdateMessage);
  }

  private async handlePlayerReady(session: HostedSession, player: PlayerInfo): Promise<void> {
    if (session.players.size < session.playerCount.min) return;
    // If all other players are ready, start the game.
    let allReady = true;
    for (const otherPlayer of session.players.values()) {
      if (otherPlayer.id !== player.id && otherPlayer.playerState !== "ready") {
        allReady = false;
        break;
      }
    }
    if (allReady) {
      if (session.controller.isInitialized) return;
      // Suppress any prompt pushes on init, since the syncAllPlayers() call will 
      // send the initial prompt to each player.
      session.suppressPromptPushes = true;
      try {
        await session.controller.init(session.id, Array.from(session.players.keys()));
      } finally {
        session.suppressPromptPushes = false;
      }
      this.syncAllPlayers(session);
    }
  }

  /** Send each connected player their projected state after game starts. */
  private syncAllPlayers(session: HostedSession): void {
    for (const [playerId, ws] of session.sockets) {
      const playerInfo = session.players.get(playerId);
      const prompt = session.controller.pendingPrompts.get(playerId);
      ws.send(
        JSON.stringify({
          type: "sync",
          data: {
            gameState: session.controller.projectStateForPlayer(playerId),
            prompt,
            messages: [],
            stateChangeSeq: playerInfo?.stateChangeSeq ?? 0,
            messageSeq: playerInfo?.messageSeq ?? 0,
          },
        } satisfies SyncServerMessage),
      );
    }
  }

  /** Push a prompt to the player who is awaiting input. */
  private pushPromptToAwaitedPlayers(
    sessionId: string,
    prompt: PlayerInputSuspension,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.suppressPromptPushes) return;
    const ws = session.sockets.get(prompt.awaiting);
    if (ws)
      ws.send(
        JSON.stringify({
          type: "prompt",
          data: prompt,
        } satisfies PromptServerMessage),
      );
  }

  /**
   * Push a game message to each player in `message.recipients`.
   * Recipients are already resolved by the runtime (see executeMessage) — the
   * server never needs to interpret the symbolic `to` value itself.
   */
  private pushGameMessageToRecipients(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const playerId of message.recipients) {
      const playerInfo = session.players.get(playerId);
      if (!playerInfo) continue;
      // Seq counts messages addressed to this seat whether delivered or queued,
      // so a client-detected gap means it genuinely missed one of its own.
      playerInfo.messageSeq++;
      const ws = session.sockets.get(playerId);
      if (ws) {
        ws.send(JSON.stringify({
          type: "message",
          seq: playerInfo.messageSeq,
          data: message,
        } satisfies GameMessageServerMessage));
      } else {
        // Not connected — queue for redelivery on reconnect sync.
        playerInfo.messageQueue.push(message);
      }
    }
  }

  /** Send projected state-change events to each connected player. */
  private pushStateChanges(sessionId: string, changes: StateChangeEvent[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const [playerId, ws] of session.sockets) {
      const projected = session.controller.projectStateChangesForPlayer(
        changes as any, playerId,
      );
      if (projected.length === 0) continue;
      const playerInfo = session.players.get(playerId);
      if (!playerInfo) continue;
      // Seq advances only on frames this seat actually receives, so an empty
      // projection doesn't leave a phantom gap that triggers a resync.
      playerInfo.stateChangeSeq++;
      ws.send(JSON.stringify({
        type: "state-change",
        seq: playerInfo.stateChangeSeq,
        data: projected,
      } satisfies StateChangeServerMessage));
    }
  }

  /** Send a message to all players in the session. */
  private broadcast(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const payload = JSON.stringify(message);
    for (const ws of session.sockets.values()) {
      ws.send(payload);
    }
  }



  /** Generate a short random session id prefixed with the game ID. */
  private createSessionId(gameId: string): string {
    // Sessions are short-lived so 5 random chars (36^5 ≈ 60M) keeps collision risk negligible.
    return Array.from(crypto.getRandomValues(new Uint8Array(5)))
      .map((b) => (b % 36).toString(36))
      .join("");
  }

  /** Generate a short random join code. */
  private createJoinCode(): string {
    // Join codes are short-lived so 4 random chars (36^4 ≈ 1.6M) keeps collision risk negligible.
    return Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((b) => (b % 36).toString(36))
      .join("");
  }

  /** Generate a secure player token. */
  private createPlayerToken(): string {
    return crypto.randomUUID();
  }
}
