import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRoutes } from './routes.js';
import { agentRoutes } from './agent-routes.js';
import { setupWebSocket } from './ws.js';
import { createBridgeMountRouter } from './bridge.js';
import { getCollabRuntime, startCollabRuntimeEmbedded, startCollabRuntimeAttached, shouldAttachToMainHttpServer } from './collab.js';
import { discoveryRoutes } from './discovery-routes.js';
import { shareWebRoutes } from './share-web-routes.js';
import {
  capabilitiesPayload,
  enforceApiClientCompatibility,
  enforceBridgeClientCompatibility,
} from './client-capabilities.js';
import { getBuildInfo } from './build-info.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '4000', 10);
const DEFAULT_ALLOWED_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'null',
];

function parseAllowedCorsOrigins(): Set<string> {
  const configured = (process.env.PROOF_CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_CORS_ORIGINS);
}

async function main(): Promise<void> {
  const app = express();
  const server = createServer(app);
  // Use noServer mode so the /ws WSS doesn't reject upgrade requests for /collab
  const wss = new WebSocketServer({ noServer: true });
  wss.on('error', (error) => {
    console.error('[server] WebSocketServer error (non-fatal):', error);
  });
  const allowedCorsOrigins = parseAllowedCorsOrigins();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((req, res, next) => {
    const originHeader = req.header('origin');
    if (originHeader && allowedCorsOrigins.has(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      [
        'Content-Type',
        'Authorization',
        'X-Proof-Client-Version',
        'X-Proof-Client-Build',
        'X-Proof-Client-Protocol',
        'x-share-token',
        'x-bridge-token',
        'x-auth-poll-token',
        'X-Agent-Id',
        'X-Window-Id',
        'X-Document-Id',
        'Idempotency-Key',
        'X-Idempotency-Key',
      ].join(', '),
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proof SDK</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 48px 24px; color: #17261d; background: #f7faf5; }
      main { max-width: 760px; margin: 0 auto; }
      h1 { font-size: 2.5rem; margin: 0 0 0.5rem; }
      p { font-size: 1.05rem; line-height: 1.6; }
      code { background: #eaf2e6; padding: 0.2rem 0.35rem; border-radius: 4px; }
      a { color: #266854; }
    </style>
  </head>
  <body>
    <main>
      <h1>Proof SDK</h1>
      <p>Open-source collaborative markdown editing with provenance tracking and an agent HTTP bridge.</p>
      <p>Start with <code>POST /documents</code>, inspect <a href="/agent-docs">agent docs</a>, or read <a href="/.well-known/agent.json">discovery metadata</a>.</p>
    </main>
  </body>
</html>`);
  });

  app.get('/health', (_req, res) => {
    const buildInfo = getBuildInfo();
    res.json({
      ok: true,
      buildInfo,
      collab: getCollabRuntime(),
    });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(capabilitiesPayload());
  });

  app.use(discoveryRoutes);
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  setupWebSocket(wss);

  // Use attached mode so collab WebSocket shares the main HTTP server.
  // Reuse the canonical helper from collab.ts (accepts 1|true|yes|on).
  const collabAttached = shouldAttachToMainHttpServer();
  if (collabAttached) {
    await startCollabRuntimeAttached(server, PORT);
  } else {
    await startCollabRuntimeEmbedded(PORT);
  }

  // Check whether the collab runtime actually registered its upgrade handler.
  // startCollabRuntimeAttached can exit early (PROOF_COLLAB_V2=false, or missing
  // signing secret on non-local URLs) without installing the /collab listener.
  const collabRuntime = getCollabRuntime();
  const collabUpgradeActive = collabAttached && collabRuntime.enabled;

  // Read COLLAB_PATH so the upgrade router matches the same path the collab
  // runtime is listening on (default: /collab).
  const collabPath = (process.env.COLLAB_PATH || '/collab').trim() || '/collab';

  // Manual upgrade routing: /ws → share WSS, collabPath → collab handler.
  // With noServer mode the share WSS no longer captures all upgrades, so both
  // WebSocket services can coexist on the same HTTP server.
  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
        return;
      }
      if (pathname === collabPath && collabUpgradeActive) {
        // Handled by the collab runtime's own upgrade listener
        // (registered by startCollabRuntimeAttached on the same server).
        return;
      }
      // Reject unknown upgrade paths (or /collab when runtime didn't start)
      // to avoid dangling connections.
      socket.destroy();
    } catch (error) {
      console.error('[server] upgrade handler error:', error);
      try { socket.destroy(); } catch { /* ignore */ }
    }
  });

  server.listen(PORT, () => {
    console.log(`[proof-sdk] listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch((error) => {
  console.error('[proof-sdk] failed to start server', error);
  process.exit(1);
});
