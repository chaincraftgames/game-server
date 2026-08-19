# @chaincraft/game-server

Hosts ChainCraft game sessions over REST and WebSocket. Built with [Hono](https://hono.dev/) on Node.js.

## Prerequisites

- Node.js 20+
- Workspace siblings must be installed first: `chaincraft-runtime`, `chaincraft-compiler`, `gamedef`

## Setup

```bash
npm install
```

This links the local workspace packages via the `file:` references in `package.json`.

## Build

```bash
npm run build
```

Output goes to `dist/`. For iterative development, use the dev server instead (see below).

## Adding Games

Games are YAML spec files placed in the `games/` directory. The filename (without extension) becomes the game ID used in all API calls.

```
games/
  high-card.yaml
  liars-dice.yaml
  my-new-game.yaml   ← add yours here
```

The server scans this directory at startup and lists every `.yaml` file as an available game. In dev mode the spec is loaded fresh on each session creation, so you can edit a spec without restarting.

The YAML format follows the `@chaincraft/gamedef` modular spec schema. See the `gamedef` package for the full spec reference.

## Running

### Development (watch mode)

```bash
npm run dev
```

Starts the server with `tsx watch` — TypeScript is executed directly and the process restarts on source changes.

### Production

```bash
npm run build
npm start
```

### Configuration

| Environment variable | Default           | Description                         |
|----------------------|-------------------|-------------------------------------|
| `PORT`               | `3001`            | HTTP/WS listen port                 |
| `GAMES_DIR`          | `<project>/games` | Directory scanned for `.yaml` specs |

## API

### Health

```
GET /health
→ { status: "ok", games: string[] }
```

### List available games

```
GET /sessions/games
→ { games: string[] }
```

### Session lifecycle

#### 1. Create a session

```
POST /sessions/:gameId/session
Body: {}
→ { sessionId: string, joinCode: string }
```

#### 2. Join a session

```
POST /sessions/:sessionId/join
Body: { playerId: string, joinCode: string }
→ { token: string }
```

Save the returned `token` — it authenticates the player's WebSocket connection.

#### 3. Connect via WebSocket

```
ws://localhost:3001/sessions/:sessionId/ws?playerId=<id>&playerToken=<token>
```

Once connected, signal readiness:

```json
{ "type": "player-status-update", "data": { "id": "<playerId>", "status": "ready" } }
```

When all players are ready, the game starts and the server pushes prompts over the socket.

#### Inspect state (optional)

```
GET /sessions/:sessionId/state    → { state }
GET /sessions/:sessionId/prompts  → { prompts }
```

## Smoke Test

A script exercises the full session lifecycle (create → join → WebSocket → ready → game start):

```bash
# Prerequisites: server running on :3001, wscat installed (npm i -g wscat), jq installed
./scripts/test-session-flow.sh [gameId]
# gameId defaults to high-card
```
