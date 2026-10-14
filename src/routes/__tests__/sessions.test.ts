import { fileURLToPath } from "url";
import { Hono } from "hono";
import { SessionManager } from "#chaincraft/session-manager.js";
import { SpecModuleLoader } from "#chaincraft/spec-module-loader.js";
import { createSessionRoutes } from "#chaincraft/routes/sessions.js";
import { MAX_QUERIES } from "#chaincraft/api-types.js";

const GAMES_DIR = fileURLToPath(new URL("../../../games", import.meta.url));

function createApp(sessions = new SessionManager()) {
  const app = new Hono();
  app.route("/sessions", createSessionRoutes(new SpecModuleLoader(GAMES_DIR), sessions));
  return app;
}

function postJson(app: Hono, path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token !== undefined && { Authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function createSession(app: Hono) {
  const res = await postJson(app, "/sessions/high-card/session", {});
  expect(res.status).toBe(200);
  return (await res.json()) as { sessionId: string; joinCode: string };
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
}

describe("REST session routes", () => {
  it("returns game-not-found for an unknown game", async () => {
    const res = await postJson(createApp(), "/sessions/no-such-game/session", {});
    await expectError(res, 404, "game-not-found");
  });

  it("does not let a gameId escape the games directory", async () => {
    const res = await postJson(createApp(), "/sessions/..%2Fpackage/session", {});
    await expectError(res, 404, "game-not-found");
  });

  it("returns session-not-found when joining an unknown session", async () => {
    const res = await postJson(createApp(), "/sessions/nope/join", {
      playerId: "alice",
      joinCode: "abcd",
    });
    await expectError(res, 404, "session-not-found");
  });

  it("returns invalid-request for a malformed or schema-invalid join body", async () => {
    const app = createApp();
    const { sessionId } = await createSession(app);
    await expectError(await postJson(app, `/sessions/${sessionId}/join`, "{not json"), 400, "invalid-request");
    await expectError(await postJson(app, `/sessions/${sessionId}/join`, { playerId: 1 }), 400, "invalid-request");
  });

  it("returns typed errors for a bad join code and a duplicate join", async () => {
    const app = createApp();
    const { sessionId, joinCode } = await createSession(app);

    const bad = await postJson(app, `/sessions/${sessionId}/join`, { playerId: "alice", joinCode: "zzzz" });
    await expectError(bad, 400, "join-code-not-found");

    const ok = await postJson(app, `/sessions/${sessionId}/join`, { playerId: "alice", joinCode });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ token: expect.any(String) });

    const dup = await postJson(app, `/sessions/${sessionId}/join`, { playerId: "alice", joinCode });
    await expectError(dup, 400, "player-already-joined");
  });

  it("no longer serves the unauthenticated state and prompts routes", async () => {
    const app = createApp();
    const { sessionId } = await createSession(app);
    expect((await app.request(`/sessions/${sessionId}/state`)).status).toBe(404);
    expect((await app.request(`/sessions/${sessionId}/prompts`)).status).toBe(404);
  });
});

describe("REST POST /sessions/:sessionId/query", () => {
  /** High Card with alice and bob joined over REST and the game started. */
  async function startedGame() {
    const sessions = new SessionManager();
    const app = createApp(sessions);
    const { sessionId, joinCode } = await createSession(app);
    const tokens: Record<string, string> = {};
    for (const playerId of ["alice", "bob"]) {
      const res = await postJson(app, `/sessions/${sessionId}/join`, { playerId, joinCode });
      tokens[playerId] = ((await res.json()) as { token: string }).token;
    }
    await sessions.updatePlayerStatus(sessionId, "alice", "ready");
    await sessions.updatePlayerStatus(sessionId, "bob", "ready");
    const session = sessions.getSession(sessionId)!;
    const awaited = session.controller.currentPrompt!.awaiting;
    const path = `/sessions/${sessionId}/query`;
    return { app, session, tokens, awaited, path };
  }

  it("returns one result per query for the token's player", async () => {
    const { app, session, tokens, awaited, path } = await startedGame();
    const card = (session.controller.promptFor(awaited)!.options as string[])[0];

    const res = await postJson(
      app,
      path,
      { promptId: 1, queries: [{ responses: [card] }, { responses: ["not-a-card"] }] },
      tokens[awaited],
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ kind: "complete" }, { kind: "illegal", index: 0, inputId: "card" }],
    });
  });

  it("requires a valid Bearer token for this session", async () => {
    const { app, tokens, awaited, path } = await startedGame();
    const other = await startedGame();
    const body = { promptId: 1, queries: [{ responses: ["x"] }] };

    await expectError(await postJson(app, path, body), 401, "unauthorized");
    await expectError(await postJson(app, path, body, "not-a-token"), 401, "unauthorized");
    await expectError(await postJson(app, path, body, other.tokens[other.awaited]), 401, "unauthorized");
    await expectError(
      await postJson(app, "/sessions/nope/query", body, tokens[awaited]),
      401,
      "unauthorized",
    );
  });

  it("returns invalid-request for malformed, empty, or oversized batches", async () => {
    const { app, tokens, awaited, path } = await startedGame();
    const token = tokens[awaited];
    const query = { responses: ["x"] };

    await expectError(await postJson(app, path, "{not json", token), 400, "invalid-request");
    await expectError(await postJson(app, path, { promptId: 1, queries: [] }, token), 400, "invalid-request");
    await expectError(
      await postJson(app, path, { promptId: 1, queries: Array(MAX_QUERIES + 1).fill(query) }, token),
      400,
      "invalid-request",
    );
    await expectError(
      await postJson(app, path, { promptId: 1, queries: [{ responses: [] }] }, token),
      400,
      "invalid-request",
    );
  });

  it("rejects a prompt id the player was never issued", async () => {
    const { app, tokens, awaited, path } = await startedGame();
    const idle = awaited === "alice" ? "bob" : "alice";

    const res = await postJson(app, path, { promptId: 1, queries: [{ responses: ["x"] }] }, tokens[idle]);

    await expectError(res, 400, "invalid-request");
  });
});
