// ---------------------------------------------------------------------------
// API (WS and REST) type contracts.
//
// Server → Client: TypeScript types only (we generate these; no need to validate
//   our own output at runtime).
//
// Client → Server: Zod schemas (we must validate untrusted input before use).
// ---------------------------------------------------------------------------

import { z } from "zod";
import type {
  PlayerInputSuspension,
  Message,
  GameOutcome,
  ProjectedState,
} from "@chaincraft/runtime";

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

/** Current game and session state sent when a player connects. */
export interface SyncServerMessage {
  type: "sync";
  data: {
    gameState: ProjectedState | undefined;
    prompt: PlayerInputSuspension | undefined;
    messages: Message[];
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
  data: Message;
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
  | PromptServerMessage
  | GameMessageServerMessage
  | GameCompleteServerMessage
  | PlayerStatusUpdateMessage
  | GameErrorServerMessage;
