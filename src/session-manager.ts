// ---------------------------------------------------------------------------
// SessionManager — in-memory session lifecycle.
//
// Holds a Map<sessionId, ManagedSession>. Each session owns a GameController
// and a set of connected WebSocket clients. Wires GameController events to
// push messages over the player's socket.
// ---------------------------------------------------------------------------

import type { WSContext } from "hono/ws";

import {
  GameController,
  IllegalActionError,
  UndoNotAllowedError,
} from "@chaincraft/runtime";
import type {
  CompiledGameModule,
  Message,
  PlayerCount,
} from "@chaincraft/runtime";
import type {
  EngineInput,
  PlayerInputSuspension,
  GameOutcome,
  WalkResult,
} from "@chaincraft/runtime";
import {
  ActionForfeitedServerMessage,
  GameCompleteServerMessage,
  GameMessageServerMessage,
  PlayerStatusUpdateMessage,
  PromptServerMessage,
  StateChangeServerMessage,
  SyncServerMessage,
  TurnEndServerMessage,
  TurnStartServerMessage,
} from "#chaincraft/api-types.js";
import type {
  ErrorPayload,
  IssuedPrompt,
  QueryResult,
  RequestedInput,
  SessionErrorType,
  StateChangeEvent,
} from "#chaincraft/api-types.js";

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
  /** Id of the last prompt issued to this player; it is current while the player has a pending prompt. */
  promptSeq: number;
}

export class SessionError extends Error {
  constructor(
    public readonly errorType: SessionErrorType,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? errorType);
    this.name = "SessionError";
  }
}

/**
 * Maps any thrown value to the wire error payload. Non-SessionErrors get `fallback`;
 * their message is only exposed when the fallback is not internal-error.
 */
export function toErrorPayload(
  e: unknown,
  fallback: SessionErrorType,
): ErrorPayload {
  if (e instanceof SessionError) {
    return e.details === undefined
      ? { code: e.errorType, message: e.message }
      : { code: e.errorType, message: e.message, details: e.details };
  }
  if (e instanceof IllegalActionError) {
    return {
      code: "illegal-action",
      message: e.message,
      details: {
        index: e.index,
        ...(e.inputId !== undefined && { inputId: e.inputId }),
        ...(e.validationMessage !== undefined && { message: e.validationMessage }),
      },
    };
  }
  if (e instanceof UndoNotAllowedError) {
    return { code: "cannot-undo", message: e.message };
  }
  if (fallback === "internal-error") {
    return { code: fallback, message: "Internal server error" };
  }
  return {
    code: fallback,
    message: e instanceof Error ? e.message : "Unknown error",
  };
}

/** The input as shown to the player; the compiled `validate` function never leaves the server. */
function toRequestedInput(input: EngineInput): RequestedInput {
  const def = input as Partial<RequestedInput>;
  return {
    id: input.id,
    ...(input.label !== undefined && { label: input.label }),
    type: input.type,
    ...(def.validationMessage !== undefined && {
      validationMessage: def.validationMessage,
    }),
    ...(def.dependsOn !== undefined && { dependsOn: def.dependsOn }),
  };
}

function toQueryResult(walk: WalkResult): QueryResult {
  if (walk.kind === "illegal") {
    return {
      kind: "illegal",
      index: walk.index,
      ...(walk.inputId !== undefined && { inputId: walk.inputId }),
      ...(walk.message !== undefined && { message: walk.message }),
    };
  }
  if (walk.next === "complete" || walk.next === "boundary") {
    return { kind: walk.next };
  }
  return {
    kind: "next",
    input: toRequestedInput(walk.next.input),
    ...(walk.next.options !== undefined && { options: walk.next.options }),
  };
}

/**
 * Represents a game in progress hosted by the server.  This has a different shape than
 * the GameSession type in the runtime, as it includes server-specific information such as
 * the join code and connected WebSocket clients.
 */
export interface HostedSession {
  /** True while controller.init() runs; sync delivers the initial prompt and state. */
  starting?: boolean;
  /** Tail of the session's serial work queue. Never rejects. */
  work: Promise<void>;
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
  /**
   * Maps player tokens to player IDs. Key is player id, value is the corresponding
   * token.
   */
  playerTokensByPlayerId: Map<string, string>;
  /**
   * Maps player IDs to player tokens. Key is player token, value is the corresponding
   * player ID.
   */
  playerIdsByPlayerToken: Map<string, string>;
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
        onPrompt: (prompt) =>
          this.pushPromptToAwaitedPlayers(sessionId, prompt),
        onMessage: (message) =>
          this.pushGameMessageToRecipients(sessionId, message),
        onComplete: (outcome) =>
          this.broadcast(sessionId, {
            type: "complete",
            data: outcome,
          } satisfies GameCompleteServerMessage),
        onStateChange: (changes) => this.pushStateChanges(sessionId, changes),
        onActionForfeit: ({ playerId, actionId, inputId }) =>
          this.pushActionForfeit(sessionId, playerId, actionId, inputId),
        onTurnStart: (turn) =>
          this.broadcastUnlessStarting(sessionId, {
            type: "turn-start",
            data: turn,
          } satisfies TurnStartServerMessage),
        onTurnEnd: (turn) =>
          this.broadcastUnlessStarting(sessionId, {
            type: "turn-end",
            data: turn,
          } satisfies TurnEndServerMessage),
      },
    });

    const session: HostedSession = {
      id: sessionId,
      gameId,
      playerCount,
      controller,
      joinCode: this.createJoinCode(),
      playerTokensByPlayerId: new Map(),
      playerIdsByPlayerToken: new Map(),
      players: new Map(),
      sockets: new Map(),
      work: Promise.resolve(),
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

  /**
   * Run `fn` after all previously queued work for the session has settled, so
   * no two operations ever interleave across an await.
   */
  runExclusive<T>(
    session: HostedSession,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const run = session.work.then(fn);
    session.work = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Verify the player's token for the session. Returns the session on success. */
  authenticate(
    sessionId: string,
    playerId: string,
    playerToken: string,
  ): HostedSession {
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new SessionError("session-not-found", "Session not found");
    if (!session.players.has(playerId))
      throw new SessionError("player-not-joined", "Player not in session");
    if (session.playerTokensByPlayerId.get(playerId) !== playerToken)
      throw new SessionError("unauthorized", "Invalid player token");
    return session;
  }

  /**
   * Resolve a player token to its session and player. Unknown sessions are also
   * "unauthorized" so the endpoint doesn't reveal which session ids exist.
   */
  authenticateToken(
    sessionId: string,
    playerToken: string,
  ): { session: HostedSession; playerId: string } {
    const session = this.sessions.get(sessionId);
    const playerId = session?.playerIdsByPlayerToken.get(playerToken);
    if (!session || playerId === undefined)
      throw new SessionError("unauthorized", "Invalid player token");
    return { session, playerId };
  }

  /**
   * Register an authenticated player's WebSocket and send them a sync. Queued so the
   * sync is a consistent cut: never taken mid-action, and every later frame follows it.
   */
  connect(
    session: HostedSession,
    playerId: string,
    ws: WSContext,
  ): Promise<void> {
    return this.runExclusive(session, () => {
      session.sockets.set(playerId, ws);

      // Before init(), the controller has no state — send empty sync.
      const initialized = session.controller.isInitialized;
      const projectedState = initialized
        ? session.controller.projectStateForPlayer(playerId)
        : undefined;
      const prompt = initialized
        ? this.currentIssuedPrompt(session, playerId)
        : undefined;
      const turn = initialized ? session.controller.currentTurn : undefined;
      const playerInfo = session.players.get(playerId);
      const queuedMessages = playerInfo?.messageQueue ?? [];

      // Send the sync message to the player.
      ws.send(
        JSON.stringify({
          type: "sync",
          data: {
            gameState: projectedState,
            prompt,
            turn,
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
    });
  }

  /** Apply a player's answer sequence, starting at their pending prompt. */
  submitPromptResponses(
    sessionId: string,
    playerId: string,
    promptId: number,
    responses: readonly unknown[],
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new SessionError("session-not-found"));
    return this.runExclusive(session, async () => {
      this.assertPromptPending(session, playerId, promptId);
      await session.controller.processResponses(playerId, responses);
    });
  }

  /** Take back the player's last answer in the current action segment; the re-prompt goes out as a new prompt. */
  undo(sessionId: string, playerId: string, promptId: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new SessionError("session-not-found"));
    return this.runExclusive(session, async () => {
      this.assertPromptPending(session, playerId, promptId);
      if (!session.controller.canUndo(playerId)) {
        throw new SessionError(
          "cannot-undo",
          `Prompt ${promptId} has nothing to undo for player "${playerId}"`,
        );
      }
      await session.controller.undo(playerId);
    });
  }

  /** Judge each response sequence against the pending prompt without applying any of them. */
  queryResponses(
    session: HostedSession,
    playerId: string,
    promptId: number,
    queries: readonly (readonly unknown[])[],
  ): Promise<QueryResult[]> {
    return this.runExclusive(session, () => {
      this.assertPromptPending(session, playerId, promptId);
      return queries.map((responses) =>
        toQueryResult(session.controller.queryResponses(playerId, responses)),
      );
    });
  }

  /** Throws unless `promptId` is the player's current, still-pending prompt. */
  private assertPromptPending(
    session: HostedSession,
    playerId: string,
    promptId: number,
  ): void {
    const playerInfo = session.players.get(playerId);
    if (!playerInfo) throw new SessionError("player-not-joined");
    if (promptId > playerInfo.promptSeq) {
      throw new SessionError(
        "invalid-request",
        `Prompt ${promptId} was never issued to player "${playerId}"`,
      );
    }
    if (
      promptId !== playerInfo.promptSeq ||
      !session.controller.pendingPrompts.has(playerId)
    ) {
      throw new SessionError(
        "stale-prompt",
        `Prompt ${promptId} is no longer pending for player "${playerId}"`,
      );
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
  join(
    session: HostedSession,
    joinCode: string,
    playerId: string,
  ): Promise<string> {
    return this.runExclusive(session, () => {
      if (session.playerTokensByPlayerId.has(playerId))
        throw new SessionError("player-already-joined");
      if (session.joinCode !== joinCode)
        throw new SessionError("join-code-not-found");
      if (session.players.size >= session.playerCount.max)
        throw new SessionError("no-available-player-slots");

      const token = this.createPlayerToken();
      session.playerTokensByPlayerId.set(playerId, token);
      session.playerIdsByPlayerToken.set(token, playerId);
      const playerInfo: PlayerInfo = {
        id: playerId,
        playerState: "joined",
        token,
        messageQueue: [],
        messageSeq: 0,
        stateChangeSeq: 0,
        promptSeq: 0,
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
    });
  }

  updatePlayerStatus(
    sessionId: string,
    playerId: string,
    status: "joined" | "ready" | "playing" | "left",
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new SessionError("session-not-found"));
    return this.runExclusive(session, async () => {
      const playerInfo = session.players.get(playerId);
      if (!playerInfo) throw new SessionError("player-not-joined");
      switch (status) {
        case "joined":
          throw new SessionError(
            "invalid-message",
            `Cannot update player status to "joined"`,
          );
        case "ready":
          await this.handlePlayerReady(session, playerInfo);
          break;
        case "playing":
        case "left":
          break;
        default:
          throw new Error(`Invalid player status: ${status}`);
      }
      playerInfo.playerState = status;
      this.broadcast(sessionId, {
        type: "player-status-update",
        data: {
          id: playerId,
          status: status,
        },
      } satisfies PlayerStatusUpdateMessage);
    });
  }

  private async handlePlayerReady(
    session: HostedSession,
    player: PlayerInfo,
  ): Promise<void> {
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
      // Suppress prompt and state-change pushes during init; syncAllPlayers() delivers both.
      session.starting = true;
      try {
        await session.controller.init(
          session.id,
          Array.from(session.players.keys()),
        );
      } finally {
        session.starting = false;
      }
      this.syncAllPlayers(session);
    }
  }

  /** Send each connected player their projected state after game starts. */
  private syncAllPlayers(session: HostedSession): void {
    for (const [playerId, ws] of session.sockets) {
      const playerInfo = session.players.get(playerId);
      const prompt = this.currentIssuedPrompt(session, playerId);
      ws.send(
        JSON.stringify({
          type: "sync",
          data: {
            gameState: session.controller.projectStateForPlayer(playerId),
            prompt,
            turn: session.controller.currentTurn,
            messages: [],
            stateChangeSeq: playerInfo?.stateChangeSeq ?? 0,
            messageSeq: playerInfo?.messageSeq ?? 0,
          },
        } satisfies SyncServerMessage),
      );
    }
  }

  /** The player's pending prompt with its id, or undefined if none is pending. */
  private currentIssuedPrompt(
    session: HostedSession,
    playerId: string,
  ): IssuedPrompt | undefined {
    const prompt = session.controller.pendingPrompts.get(playerId);
    const playerInfo = session.players.get(playerId);
    if (!prompt || !playerInfo) return undefined;
    return {
      ...prompt,
      input: toRequestedInput(prompt.input),
      promptId: playerInfo.promptSeq,
      canUndo: session.controller.canUndo(playerId),
    };
  }

  /** Issue the next prompt id to the awaited player and push the prompt to them. */
  private pushPromptToAwaitedPlayers(
    sessionId: string,
    prompt: PlayerInputSuspension,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const playerInfo = session.players.get(prompt.awaiting);
    if (!playerInfo) return;
    // Assigned even while starting: the post-start sync carries this id.
    const promptId = ++playerInfo.promptSeq;
    if (session.starting) return;
    const ws = session.sockets.get(prompt.awaiting);
    if (ws)
      ws.send(
        JSON.stringify({
          type: "prompt",
          data: {
            ...prompt,
            input: toRequestedInput(prompt.input),
            promptId,
            canUndo: session.controller.canUndo(prompt.awaiting),
          },
        } satisfies PromptServerMessage),
      );
  }

  /**
   * Push a game message to each player in `message.recipients`.
   * Recipients are already resolved by the runtime (see executeMessage) — the
   * server never needs to interpret the symbolic `to` value itself.
   */
  private pushGameMessageToRecipients(
    sessionId: string,
    message: Message,
  ): void {
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
        ws.send(
          JSON.stringify({
            type: "message",
            seq: playerInfo.messageSeq,
            data: message,
          } satisfies GameMessageServerMessage),
        );
      } else {
        // Not connected — queue for redelivery on reconnect sync.
        playerInfo.messageQueue.push(message);
      }
    }
  }

  /** Send projected state-change events to each connected player. */
  private pushStateChanges(
    sessionId: string,
    changes: StateChangeEvent[],
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.starting) return;
    for (const [playerId, ws] of session.sockets) {
      const projected = session.controller.projectStateChangesForPlayer(
        changes as any,
        playerId,
      );
      if (projected.length === 0) continue;
      const playerInfo = session.players.get(playerId);
      if (!playerInfo) continue;
      // Seq advances only on frames this seat actually receives, so an empty
      // projection doesn't leave a phantom gap that triggers a resync.
      playerInfo.stateChangeSeq++;
      ws.send(
        JSON.stringify({
          type: "state-change",
          seq: playerInfo.stateChangeSeq,
          data: projected,
        } satisfies StateChangeServerMessage),
      );
    }
  }

  /** Tell the actor their action was forfeited; other players just see the turn continue. */
  private pushActionForfeit(
    sessionId: string,
    playerId: string,
    actionId: string | undefined,
    inputId: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.starting) return;
    session.sockets.get(playerId)?.send(
      JSON.stringify({
        type: "action-forfeited",
        data: { actionId, inputId },
      } satisfies ActionForfeitedServerMessage),
    );
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

  /** Broadcast, except during init — the post-start sync carries the same information. */
  private broadcastUnlessStarting(sessionId: string, message: unknown): void {
    if (this.sessions.get(sessionId)?.starting) return;
    this.broadcast(sessionId, message);
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
