// ---------------------------------------------------------------------------
// Game Server — entry point.
//
// Hono on Node with @hono/node-ws for WebSocket support.
// Uses SpecModuleLoader (dev/playtest) to load games from a local directory.
// ---------------------------------------------------------------------------

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { SpecModuleLoader } from './spec-module-loader.js';
import { SessionManager } from './session-manager.js';
import { createSessionRoutes } from './routes/sessions.js';
import { registerWsRoute } from './routes/ws.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const GAMES_DIR = process.env.GAMES_DIR ?? join(__dirname, '../games');

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const app = new Hono();
const loader = new SpecModuleLoader(GAMES_DIR);
const sessions = new SessionManager();

// Health check
app.get('/health', (c) => c.json({ status: 'ok', games: loader.listGames() }));

// REST routes
app.route('/sessions', createSessionRoutes(loader, sessions));

// WebSocket route
const { injectWebSocket } = registerWsRoute(app, sessions);

// Start server
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`🎮 Game server listening on http://localhost:${info.port}`);
  console.log(`   Games directory: ${GAMES_DIR}`);
  console.log(`   Available games: ${loader.listGames().join(', ') || '(none)'}`);
});

// Attach WebSocket handler to the Node HTTP server
injectWebSocket(server);
