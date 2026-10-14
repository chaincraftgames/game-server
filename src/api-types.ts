// ---------------------------------------------------------------------------
// API (WS and REST) type contracts.
//
// Server → Client: TypeScript types only (we generate these; no need to validate
//   our own output at runtime).
//
// Client → Server: Zod schemas (we must validate untrusted input before use).
//
// Wire-format types are self-contained — no dependency on @chaincraft/runtime.
// The server maps from runtime types to these at the serialization boundary.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type {
  EngineInput,
  InputOption,
  PlayerInputSuspension,
  Message,
  GameOutcome,
  ProjectedState,
  TurnInfo,
} from "@chaincraft/runtime";

// ---------------------------------------------------------------------------
// State change events 
// ---------------------------------------------------------------------------

export type InventoryPosition =
  | { kind: "stack-top" }
  | { kind: "stack-bottom" }
  | { kind: "stack-index"; index: number }
  | { kind: "line-index"; index: number }
  | { kind: "grid-cell"; row: string | number; col: string | number }
  | { kind: "graph-node"; nodeId: string };

export interface InventoryRef {
  inventoryId: string;
  ownerId?: string;
}

export interface PieceMovedEvent {
  kind: "piece:moved";
  pieceId: string;
  from: { inventory: InventoryRef; position?: InventoryPosition };
  to: { inventory: InventoryRef; position?: InventoryPosition };
}

export interface PiecesDistributedEvent {
  kind: "pieces:distributed";
  from: { inventory: InventoryRef; position?: InventoryPosition };
  deals: Array<{
    pieceId: string;
    to: { inventory: InventoryRef; position?: InventoryPosition };
  }>;
}

export interface PieceFlippedEvent {
  kind: "piece:flipped";
  pieceId: string;
  faceUp: boolean;
}

export interface PieceRolledEvent {
  kind: "piece:rolled";
  pieceId: string;
  faceValue: number;
}

export interface PieceOrientedEvent {
  kind: "piece:oriented";
  pieceId: string;
  orientationIndex: number;
}

export interface PieceExhaustedEvent {
  kind: "piece:exhausted";
  pieceId: string;
  exhausted: boolean;
}

export interface PiecePropertyChangedEvent {
  kind: "piece:property-changed";
  pieceId: string;
  property: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface PieceRevealedEvent {
  kind: "piece:revealed";
  pieceId: string;
  visibleTo: string[] | "all";
}

export interface PieceHiddenEvent {
  kind: "piece:hidden";
  pieceId: string;
}

export interface InventoryShuffledEvent {
  kind: "inventory:shuffled";
  inventory: InventoryRef;
}

export interface StatePropertyChangedEvent {
  kind: "state:property-changed";
  scope: "game" | "player";
  playerId?: string;
  property: string;
  oldValue: unknown;
  newValue: unknown;
}

export type StateChangeEvent =
  | PieceMovedEvent
  | PiecesDistributedEvent
  | PieceFlippedEvent
  | PieceRolledEvent
  | PieceOrientedEvent
  | PieceExhaustedEvent
  | PiecePropertyChangedEvent
  | PieceRevealedEvent
  | PieceHiddenEvent
  | InventoryShuffledEvent
  | StatePropertyChangedEvent;

// ---------------------------------------------------------------------------
// Server → Client messages (REST)
// ---------------------------------------------------------------------------
/** Request body for creating a session. */
export const CreateSessionRequestSchema = z.object({});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/** Response to a create session request. */
export const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
  joinCode: z.string(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/** Request body for joining a session. */
export const JoinSessionRequestSchema = z.object({
  playerId: z.string(),
  joinCode: z.string(),
});
export type JoinSessionRequest = z.infer<typeof JoinSessionRequestSchema>;

/** Response to a join session request. */
export interface JoinSessionResponse {
  token: string;
}

/** Action choice plus up to 4 player inputs. */
export const MAX_PROMPT_RESPONSES = 5;

/** Most response sequences one query request may carry. */
export const MAX_QUERIES = 32;

/**
 * Asks what each response sequence would lead to if submitted for the pending prompt
 * `promptId`, without applying any of them. Authenticated with `Authorization: Bearer <token>`.
 */
export const QueryRequestSchema = z.object({
  promptId: z.number().int().positive(),
  queries: z
    .array(
      z.object({
        responses: z.array(z.unknown()).min(1).max(MAX_PROMPT_RESPONSES),
      }),
    )
    .min(1)
    .max(MAX_QUERIES),
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

/** What submitting one response sequence would lead to. */
export type QueryResult =
  /** The sequence is legal so far; this input would be requested next. */
  | { kind: "next"; input: RequestedInput; options?: InputOption[] }
  /** The sequence completes the action. */
  | { kind: "complete" }
  /** The sequence is legal, but the next input can only be requested after effects run. */
  | { kind: "boundary" }
  /** The answer at `index` would be rejected; same details as an illegal-action error. */
  | { kind: "illegal"; index: number; inputId?: string; message?: string };

/** Response to a query request: one result per query, in order. */
export interface QueryResponse {
  results: QueryResult[];
}

/** Error response from the server. Same payload as the WS `error` frame's data. */
export interface ServerErrorResponse {
  error: ErrorPayload;
}

// ---------------------------------------------------------------------------
// Client → Server messages (WS)
// ---------------------------------------------------------------------------

/** 
 * Player updates their status.  Also used by the server to communicate status changes
 * to other players in the session.
 */
export const PlayerStatusUpdateMessage = z.object({
  type: z.literal("player-status-update"),
  data: z.object({
    id: z.string(),
    status: z.enum(["joined", "ready", "playing", "left"]),
  }),
});
export type PlayerStatusUpdateMessage = z.infer<typeof PlayerStatusUpdateMessage>;

/**
 * Player submits answers starting at a pending prompt: the prompt's answer, then answers to
 * the prompts that would follow within the same action. Each answer's shape matches its
 * input type (e.g. a piece ID for gamepiece-select, an action choice for action-select).
 * All-or-nothing: any illegal answer rejects the whole submission.
 */
export const ClientPromptResponseMessage = z.object({
  type: z.literal("prompt-response"),
  data: z.object({
    /** The `promptId` of the prompt being answered. */
    promptId: z.number().int().positive(),
    responses: z.array(z.unknown()).min(1).max(MAX_PROMPT_RESPONSES),
  }),
});
export type ClientPromptResponseMessage = z.infer<typeof ClientPromptResponseMessage>;

/** Discriminated union of all client → server message shapes. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  PlayerStatusUpdateMessage,
  ClientPromptResponseMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server → Client messages (WS)
// ---------------------------------------------------------------------------

/** An input as requested from a player: the engine's input with its compiled rules removed. */
export interface RequestedInput {
  id: string;
  label?: string;
  type: RequestedInputType;
  validationMessage?: string;
  /** Earlier inputs of the same action whose answers change this input's options. */
  dependsOn?: readonly string[];
}

type WithoutFilter<T> = T extends unknown ? Omit<T, "filter"> : never;
export type RequestedInputType = WithoutFilter<EngineInput["type"]>;

/** A prompt as issued to its player. `promptId` is per-player monotonic. */
export type IssuedPrompt = Omit<PlayerInputSuspension, "input"> & {
  input: RequestedInput;
  promptId: number;
};

/** Current game and session state sent when a player connects or reconnects. */
export interface SyncServerMessage {
  type: "sync";
  data: {
    gameState: ProjectedState | undefined;
    prompt: IssuedPrompt | undefined;
    /** The active turn, or undefined between turns / before start / after completion. */
    turn: TurnInfo | undefined;
    messages: Message[];
    stateChangeSeq: number;
    messageSeq: number;
  };
}

/** Server is prompting a player for input. */
export interface PromptServerMessage {
  type: "prompt";
  data: IssuedPrompt;
}

/** Server is sending a game message. */
export interface GameMessageServerMessage {
  type: "message";
  seq: number;
  data: Message;
}

/** Batch of state mutations, split at turn boundaries. */
export interface StateChangeServerMessage {
  type: "state-change";
  seq: number;
  data: StateChangeEvent[];
}

/** A turn started. Broadcast to all players. */
export interface TurnStartServerMessage {
  type: "turn-start";
  data: TurnInfo;
}

/** A turn ended. Broadcast to all players. */
export interface TurnEndServerMessage {
  type: "turn-end";
  data: TurnInfo;
}

/** Game has completed. */
export interface GameCompleteServerMessage {
  type: "complete";
  data: GameOutcome;
}

export type SessionErrorType =
  | "session-not-found"
  | "game-not-found"
  | "player-already-joined"
  | "join-code-not-found"
  | "player-not-joined"
  | "no-available-player-slots"
  | "stale-prompt"
  | "illegal-action"
  | "unauthorized"
  | "invalid-message"
  | "invalid-request"
  | "internal-error";

/** Error payload shared by REST error responses and WS error frames. */
export interface ErrorPayload {
  code: SessionErrorType;
  message: string;
  details?: unknown;
}

/** Server encountered an error processing a client message. */
export interface GameErrorServerMessage {
  type: "error";
  data: ErrorPayload;
}

/** All server → client message shapes. */
export type ServerMessage =
  | SyncServerMessage
  | PromptServerMessage
  | GameMessageServerMessage
  | StateChangeServerMessage
  | TurnStartServerMessage
  | TurnEndServerMessage
  | GameCompleteServerMessage
  | PlayerStatusUpdateMessage
  | GameErrorServerMessage;
