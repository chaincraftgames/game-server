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
  PlayerInputSuspension,
  Message,
  GameOutcome,
  ProjectedState,
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

/** Response to a get session state request. */
export const GetSessionStateResponseSchema = z.object({
  state: z.unknown(),
});
export type GetSessionStateResponse = z.infer<
  typeof GetSessionStateResponseSchema
>;

/** Response to a get session prompts request. */
export const GetSessionPromptsResponseSchema = z.object({
  prompts: z.array(z.unknown()),
});
export type GetSessionPromptsResponse = z.infer<
  typeof GetSessionPromptsResponseSchema
>;

/** Error response from the server. */
export interface ServerErrorResponse {
  error: string;
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
 * Player submits a response to a pending prompt.
 * `value` is the player's answer — its shape matches the prompt's input type
 * (e.g. a piece ID string for gamepiece-select, an action ID string for action-select).
 */
export const ClientPromptResponseMessage = z.object({
  type: z.literal("prompt-response"),
  data: z.object({
    value: z.unknown(),
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

/** Current game and session state sent when a player connects or reconnects. */
export interface SyncServerMessage {
  type: "sync";
  data: {
    gameState: ProjectedState | undefined;
    prompt: PlayerInputSuspension | undefined;
    messages: Message[];
    stateChangeSeq: number;
    messageSeq: number;
  };
}

/** Server is prompting a player for input. */
export interface PromptServerMessage {
  type: "prompt";
  data: PlayerInputSuspension;
}

/** Server is sending a game message. */
export interface GameMessageServerMessage {
  type: "message";
  seq: number;
  data: Message;
}

/** Batch of state mutations from one action. */
export interface StateChangeServerMessage {
  type: "state-change";
  seq: number;
  data: StateChangeEvent[];
}

/** Game has completed. */
export interface GameCompleteServerMessage {
  type: "complete";
  data: GameOutcome;
}

export type SessionErrorType =
  | "session-not-found"
  | "player-already-joined"
  | "join-code-not-found"
  | "player-not-joined"
  | "no-available-player-slots"
  | "invalid-message"
  | "invalid-request";

/** Server encountered an error processing a client message. */
export interface GameErrorServerMessage {
  type: "error";
  data: {
    code: SessionErrorType;
    message: string;
  };
}

/** All server → client message shapes. */
export type ServerMessage =
  | SyncServerMessage
  | PromptServerMessage
  | GameMessageServerMessage
  | StateChangeServerMessage
  | GameCompleteServerMessage
  | PlayerStatusUpdateMessage
  | GameErrorServerMessage;
