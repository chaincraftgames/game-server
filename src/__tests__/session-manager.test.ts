import { fileURLToPath } from "url";
import type { WSContext } from "hono/ws";
import { SessionManager, SessionError } from "#chaincraft/session-manager.js";
import type { HostedSession } from "#chaincraft/session-manager.js";
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

/** Creates a High Card session with alice and bob joined and connected, not yet started. */
async function joinedSession(manager: SessionManager) {
  const session = await manager.createSession("high-card", await loader.load("high-card"));
  const tokens: Record<string, string> = {};
  const sockets: Record<string, FakeSocket> = {};
  for (const playerId of ["alice", "bob"]) {
    tokens[playerId] = await manager.join(session, session.joinCode, playerId);
    sockets[playerId] = fakeSocket();
    await manager.connect(session, playerId, sockets[playerId].ws);
  }
  return { session, tokens, sockets };
}

async function startedSession(manager: SessionManager) {
  const joined = await joinedSession(manager);
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
    expect(awaitedSync.data.prompt).toEqual(
      JSON.parse(JSON.stringify(session.controller.promptFor(awaited))),
    );
  });
});

describe("SessionManager.submitPromptResponse", () => {
  it("rejects a response from a player with no pending prompt and leaves state untouched", async () => {
    const manager = new SessionManager();
    const { session } = await startedSession(manager);
    const awaited = awaitedPlayer(session);
    const other = awaited === "alice" ? "bob" : "alice";
    const before = session.controller.getState();

    await expectSessionError(
      manager.submitPromptResponse(session.id, other, "anything"),
      "not-awaiting-input",
    );
    expect(session.controller.getState()).toEqual(before);
  });

  it("queues back-to-back responses so the second is checked against post-action state", async () => {
    const manager = new SessionManager();
    const { session } = await startedSession(manager);
    const first = awaitedPlayer(session);
    const second = first === "alice" ? "bob" : "alice";
    const firstValue = (session.controller.promptFor(first)!.options as string[])[0];
    const hand = session.controller.getState().players[second].inventories.hand;
    const secondValue = ("pieceIds" in hand ? hand.pieceIds : [])[0];

    // Second player has no prompt yet; it only becomes valid once the first action settles.
    const a = manager.submitPromptResponse(session.id, first, firstValue);
    const b = manager.submitPromptResponse(session.id, second, secondValue);

    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
  });

  it("sends state changes before the next prompt frame", async () => {
    const manager = new SessionManager();
    const { session, sockets } = await startedSession(manager);
    const first = awaitedPlayer(session);
    const second = first === "alice" ? "bob" : "alice";
    const value = (session.controller.promptFor(first)!.options as string[])[0];

    await manager.submitPromptResponse(session.id, first, value);

    const types = framesAfterLastSync(sockets[second]).map((f) => f.type);
    expect(types).toContain("state-change");
    expect(types).toContain("prompt");
    expect(types.lastIndexOf("state-change")).toBeLessThan(types.indexOf("prompt"));
  });
});
