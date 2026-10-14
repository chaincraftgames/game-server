import { fileURLToPath } from "url";
import type { WSContext } from "hono/ws";
import { IllegalActionError } from "@chaincraft/runtime";
import { SessionManager, SessionError, toErrorPayload } from "#chaincraft/session-manager.js";
import type { HostedSession } from "#chaincraft/session-manager.js";
import { ClientMessageSchema } from "#chaincraft/api-types.js";
import { SpecModuleLoader } from "#chaincraft/spec-module-loader.js";

const GAMES_DIR = fileURLToPath(new URL("../../games", import.meta.url));
const loader = new SpecModuleLoader(GAMES_DIR);

interface FakeSocket {
  ws: WSContext;
  frames: Array<{ type: string; [key: string]: any }>;
}

function fakeSocket(): FakeSocket {
  const frames: FakeSocket["frames"] = [];
  const ws = {
    send: (data: string) => frames.push(JSON.parse(data)),
    close: () => {},
  } as unknown as WSContext;
  return { ws, frames };
}

async function expectSessionError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SessionError);
  await expect(promise).rejects.toMatchObject({ errorType: code });
}

/** Creates a session with alice and bob joined and connected, not yet started. */
async function joinedSession(manager: SessionManager, gameId = "high-card") {
  const session = await manager.createSession(gameId, await loader.load(gameId));
  const tokens: Record<string, string> = {};
  const sockets: Record<string, FakeSocket> = {};
  for (const playerId of ["alice", "bob"]) {
    tokens[playerId] = await manager.join(session, session.joinCode, playerId);
    sockets[playerId] = fakeSocket();
    await manager.connect(session, playerId, sockets[playerId].ws);
  }
  return { session, tokens, sockets };
}

async function startedSession(manager: SessionManager, gameId?: string) {
  const joined = await joinedSession(manager, gameId);
  await manager.updatePlayerStatus(joined.session.id, "alice", "ready");
  await manager.updatePlayerStatus(joined.session.id, "bob", "ready");
  return joined;
}

function framesAfterLastSync(socket: FakeSocket) {
  const lastSync = socket.frames.map((f) => f.type).lastIndexOf("sync");
  return socket.frames.slice(lastSync + 1);
}

function awaitedPlayer(session: HostedSession): string {
  return session.controller.currentPrompt!.awaiting;
}

describe("toErrorPayload", () => {
  it("puts an illegal action's validation message in details", () => {
    const error = new IllegalActionError("rejected", 0, "faceValue", "Bid higher");
    expect(toErrorPayload(error, "internal-error")).toEqual({
      code: "illegal-action",
      message: "rejected",
      details: { index: 0, inputId: "faceValue", message: "Bid higher" },
    });
  });
});

describe("SessionManager.runExclusive", () => {
  it("runs queued work strictly in order without interleaving", async () => {
    const manager = new SessionManager();
    const { session } = await joinedSession(manager);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const first = manager.runExclusive(session, async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = manager.runExclusive(session, () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("keeps processing after a queued operation rejects", async () => {
    const manager = new SessionManager();
    const { session } = await joinedSession(manager);

    const failing = manager.runExclusive(session, () => {
      throw new Error("boom");
    });
    const next = manager.runExclusive(session, () => "ran");

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ran");
  });
});

describe("SessionManager.authenticate", () => {
  it("returns the session for a valid token", async () => {
    const manager = new SessionManager();
    const { session, tokens } = await joinedSession(manager);
    expect(manager.authenticate(session.id, "alice", tokens.alice)).toBe(session);
  });

  it("rejects another player's token as unauthorized", async () => {
    const manager = new SessionManager();
    const { session, tokens } = await joinedSession(manager);
    expect(() => manager.authenticate(session.id, "alice", tokens.bob)).toThrow(
      expect.objectContaining({ errorType: "unauthorized" }),
    );
  });

  it("rejects unknown players and sessions", async () => {
    const manager = new SessionManager();
    const { session, tokens } = await joinedSession(manager);
    expect(() => manager.authenticate(session.id, "carol", tokens.alice)).toThrow(
      expect.objectContaining({ errorType: "player-not-joined" }),
    );
    expect(() => manager.authenticate("nope", "alice", tokens.alice)).toThrow(
      expect.objectContaining({ errorType: "session-not-found" }),
    );
  });
});

describe("SessionManager game start", () => {
  it("delivers initial state and prompt only via sync, with no earlier state-change or prompt frames", async () => {
    const manager = new SessionManager();
    const { session, sockets } = await startedSession(manager);

    for (const playerId of ["alice", "bob"]) {
      const types = sockets[playerId].frames.map((f) => f.type);
      expect(types).not.toContain("state-change");
      expect(types).not.toContain("prompt");

      const gameSync = sockets[playerId].frames.filter((f) => f.type === "sync").at(-1)!;
      expect(gameSync.data.gameState).toBeDefined();
      expect(gameSync.data.stateChangeSeq).toBe(0);
    }

    const awaited = awaitedPlayer(session);
    const awaitedSync = sockets[awaited].frames.filter((f) => f.type === "sync").at(-1)!;
    expect(awaitedSync.data.prompt).toEqual({
      ...JSON.parse(JSON.stringify(session.controller.promptFor(awaited))),
      promptId: 1,
    });
  });

  it("delivers the initial turn only via sync, with no earlier turn frames", async () => {
    const manager = new SessionManager();
    const { session, sockets } = await startedSession(manager);
    const turn = session.controller.currentTurn;
    expect(turn).toEqual({ nodeId: expect.any(String), label: expect.any(String), actors: [awaitedPlayer(session)] });

    for (const playerId of ["alice", "bob"]) {
      const types = sockets[playerId].frames.map((f) => f.type);
      expect(types).not.toContain("turn-start");
      expect(types).not.toContain("turn-end");
      const gameSync = sockets[playerId].frames.filter((f) => f.type === "sync").at(-1)!;
      expect(gameSync.data.turn).toEqual(turn);
    }
  });
});

describe("SessionManager.submitPromptResponses", () => {
  function firstOption(session: HostedSession, playerId: string): string {
    return (session.controller.promptFor(playerId)!.options as string[])[0];
  }

  it("rejects a prompt id never issued to a player with no pending prompt and leaves state untouched", async () => {
    const manager = new SessionManager();
    const { session } = await startedSession(manager);
    const awaited = awaitedPlayer(session);
    const other = awaited === "alice" ? "bob" : "alice";
    const before = session.controller.getState();

    await expectSessionError(
      manager.submitPromptResponses(session.id, other, 1, ["anything"]),
      "invalid-request",
    );
    expect(session.controller.getState()).toEqual(before);
  });

  it("rejects a prompt id ahead of the pending prompt and leaves state untouched", async () => {
    const manager = new SessionManager();
    const { session } = await startedSession(manager);
    const awaited = awaitedPlayer(session);
    const before = session.controller.getState();

    await expectSessionError(
      manager.submitPromptResponses(session.id, awaited, 2, [firstOption(session, awaited)]),
      "invalid-request",
    );
    expect(session.controller.getState()).toEqual(before);
  });

  it("rejects a double-submit as stale-prompt and leaves state untouched", async () => {
    const manager = new SessionManager();
    const { session } = await startedSession(manager);
    const first = awaitedPlayer(session);
    const hand = session.controller.getState().players[first].inventories.hand;
    const [cardA, cardB] = "pieceIds" in hand ? hand.pieceIds : [];

    const a = manager.submitPromptResponses(session.id, first, 1, [cardA]);
    const b = manager.submitPromptResponses(session.id, first, 1, [cardB]);

    await expect(a).resolves.toBeUndefined();
    const afterFirst = session.controller.getState();
    await expectSessionError(b, "stale-prompt");
    expect(session.controller.getState()).toEqual(afterFirst);
  });

  it("rejects a superseded prompt id as stale-prompt while a newer prompt is pending", async () => {
    const manager = new SessionManager();
    const { session } = await startedSession(manager);
    const first = awaitedPlayer(session);
    const second = first === "alice" ? "bob" : "alice";
    await manager.submitPromptResponses(session.id, first, 1, [firstOption(session, first)]);
    await manager.submitPromptResponses(session.id, second, 1, [firstOption(session, second)]);
    // Both players have now been issued prompt 1, so whoever leads next holds prompt 2.
    const next = awaitedPlayer(session);
    const before = session.controller.getState();

    await expectSessionError(
      manager.submitPromptResponses(session.id, next, 1, [firstOption(session, next)]),
      "stale-prompt",
    );
    expect(session.controller.getState()).toEqual(before);
    await expect(
      manager.submitPromptResponses(session.id, next, 2, [firstOption(session, next)]),
    ).resolves.toBeUndefined();
  });

  it("numbers prompts per player and sends the id on prompt frames and reconnect sync", async () => {
    const manager = new SessionManager();
    const { session, sockets } = await startedSession(manager);
    const first = awaitedPlayer(session);
    const second = first === "alice" ? "bob" : "alice";

    await manager.submitPromptResponses(session.id, first, 1, [firstOption(session, first)]);

    const promptFrames = framesAfterLastSync(sockets[second]).filter((f) => f.type === "prompt");
    expect(promptFrames.map((f) => f.data.promptId)).toEqual([1]);

    const reconnect = fakeSocket();
    await manager.connect(session, second, reconnect.ws);
    expect(reconnect.frames[0].data.prompt.promptId).toBe(1);
  });

  it("rejects an illegal value as illegal-action and accepts a retry with the same prompt id", async () => {
    const manager = new SessionManager();
    const { session, sockets } = await startedSession(manager);
    const awaited = awaitedPlayer(session);
    const before = session.controller.getState();
    const framesBefore = sockets[awaited].frames.length;

    const rejected = manager.submitPromptResponses(session.id, awaited, 1, ["not-a-card"]);
    await expect(rejected).rejects.toBeInstanceOf(IllegalActionError);
    await rejected.catch((e) => {
      expect(toErrorPayload(e, "internal-error")).toEqual({
        code: "illegal-action",
        message: expect.any(String),
        details: { index: 0, inputId: "card" },
      });
    });
    expect(session.controller.getState()).toEqual(before);
    expect(sockets[awaited].frames).toHaveLength(framesBefore);
    expect(session.players.get(awaited)!.promptSeq).toBe(1);

    await expect(
      manager.submitPromptResponses(session.id, awaited, 1, [firstOption(session, awaited)]),
    ).resolves.toBeUndefined();
  });

  it("queues back-to-back responses so the second is checked against post-action state", async () => {
    const manager = new SessionManager();
    const { session } = await startedSession(manager);
    const first = awaitedPlayer(session);
    const second = first === "alice" ? "bob" : "alice";
    const firstValue = firstOption(session, first);
    const hand = session.controller.getState().players[second].inventories.hand;
    const secondValue = ("pieceIds" in hand ? hand.pieceIds : [])[0];

    // Second player has no prompt yet; it only becomes valid once the first action settles.
    const a = manager.submitPromptResponses(session.id, first, 1, [firstValue]);
    const b = manager.submitPromptResponses(session.id, second, 1, [secondValue]);

    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });

  it("sends state changes before the next prompt frame", async () => {
    const manager = new SessionManager();
    const { session, sockets } = await startedSession(manager);
    const first = awaitedPlayer(session);
    const second = first === "alice" ? "bob" : "alice";
    const value = firstOption(session, first);

    await manager.submitPromptResponses(session.id, first, 1, [value]);

    const types = framesAfterLastSync(sockets[second]).map((f) => f.type);
    expect(types).toContain("state-change");
    expect(types).toContain("prompt");
    expect(types.lastIndexOf("state-change")).toBeLessThan(types.indexOf("prompt"));
  });

  it("broadcasts turn-end then turn-start to every player, after the action's state changes", async () => {
    const manager = new SessionManager();
    const { session, sockets } = await startedSession(manager);
    const first = awaitedPlayer(session);
    const second = first === "alice" ? "bob" : "alice";
    const value = firstOption(session, first);

    await manager.submitPromptResponses(session.id, first, 1, [value]);

    for (const playerId of ["alice", "bob"]) {
      const frames = framesAfterLastSync(sockets[playerId]);
      const turnFrames = frames.filter((f) => f.type.startsWith("turn-"));
      expect(turnFrames.map((f) => [f.type, f.data.actors])).toEqual([
        ["turn-end", [first]],
        ["turn-start", [second]],
      ]);
      const types = frames.map((f) => f.type);
      expect(types.lastIndexOf("state-change")).toBeLessThan(types.indexOf("turn-end"));
    }
    const secondTypes = framesAfterLastSync(sockets[second]).map((f) => f.type);
    expect(secondTypes.indexOf("turn-start")).toBeLessThan(secondTypes.indexOf("prompt"));
  });
});

describe("SessionManager.submitPromptResponses — sequences (Liar's Dice makeBid)", () => {
  const makeBid = { kind: "act", actionId: "makeBid" };

  async function liarsDice(manager: SessionManager) {
    const started = await startedSession(manager, "liars-dice");
    const first = awaitedPlayer(started.session);
    const second = first === "alice" ? "bob" : "alice";
    return { ...started, first, second };
  }

  function promptFrames(socket: FakeSocket) {
    return framesAfterLastSync(socket).filter((f) => f.type === "prompt");
  }

  it("applies complete sequences and prompts only the next player", async () => {
    const manager = new SessionManager();
    const { session, sockets, first, second } = await liarsDice(manager);

    // Opening bid: makeBid is the only legal action, so the first prompt is its quantity.
    await manager.submitPromptResponses(session.id, first, 1, [3, 4]);

    expect(promptFrames(sockets[first])).toEqual([]);
    expect(promptFrames(sockets[second]).map((f) => [f.data.promptId, f.data.input.type.kind])).toEqual([
      [1, "action-select"],
    ]);

    await manager.submitPromptResponses(session.id, second, 1, [makeBid, 4, 4]);

    const props = session.controller.getState().gameProperties;
    expect([props.currentBidQuantity, props.currentBidFace, props.currentBidder]).toEqual([4, 4, second]);
    expect(promptFrames(sockets[second])).toHaveLength(1);
    expect(promptFrames(sockets[first]).map((f) => f.data.promptId)).toEqual([2]);
  });

  it("stops a partial sequence at the next input with a new prompt id, which then completes it", async () => {
    const manager = new SessionManager();
    const { session, sockets, first } = await liarsDice(manager);

    await manager.submitPromptResponses(session.id, first, 1, [3]);

    const frames = promptFrames(sockets[first]);
    expect(frames.map((f) => [f.data.promptId, f.data.input.id])).toEqual([[2, "faceValue"]]);
    await manager.submitPromptResponses(session.id, first, 2, [4]);
    const props = session.controller.getState().gameProperties;
    expect([props.currentBidQuantity, props.currentBidFace]).toEqual([3, 4]);
  });

  it("rejects a sequence whose later answer fails validation, changing nothing, and accepts a retry", async () => {
    const manager = new SessionManager();
    const { session, sockets, first, second } = await liarsDice(manager);
    await manager.submitPromptResponses(session.id, first, 1, [3, 4]);
    const before = session.controller.getState();
    const frameCounts = [sockets.alice.frames.length, sockets.bob.frames.length];

    const rejected = manager.submitPromptResponses(session.id, second, 1, [makeBid, 3, 2]);
    await expect(rejected).rejects.toBeInstanceOf(IllegalActionError);
    await rejected.catch((e) => {
      expect(toErrorPayload(e, "internal-error")).toEqual({
        code: "illegal-action",
        message: expect.any(String),
        details: {
          index: 2,
          inputId: "faceValue",
          message: "Bid a higher quantity, or the same quantity with a higher face value.",
        },
      });
    });
    expect(session.controller.getState()).toEqual(before);
    expect([sockets.alice.frames.length, sockets.bob.frames.length]).toEqual(frameCounts);
    expect(session.players.get(second)!.promptSeq).toBe(1);

    await expect(
      manager.submitPromptResponses(session.id, second, 1, [makeBid, 3, 5]),
    ).resolves.toBeUndefined();
  });
});

describe("ClientMessageSchema prompt-response", () => {
  const parse = (data: unknown) => ClientMessageSchema.safeParse({ type: "prompt-response", data });

  it("accepts one to five responses", () => {
    expect(parse({ promptId: 1, responses: ["a"] }).success).toBe(true);
    expect(parse({ promptId: 1, responses: [1, 2, 3, 4, 5] }).success).toBe(true);
  });

  it("rejects empty, oversized, and legacy single-value submissions", () => {
    expect(parse({ promptId: 1, responses: [] }).success).toBe(false);
    expect(parse({ promptId: 1, responses: [1, 2, 3, 4, 5, 6] }).success).toBe(false);
    expect(parse({ promptId: 1, value: "a" }).success).toBe(false);
  });
});
