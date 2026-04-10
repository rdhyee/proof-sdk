# Self-Hosting Proof SDK: Deployment Guide & Agent Experience Notes

*Notes from deploying proof-sdk to a Linode Nanode (1GB RAM) behind Nginx, March 12, 2026.*
*Deployment done collaboratively by Raymond Yee and Claude Code (Opus 4.6).*

## Quick Start (Single-Port Production Deploy)

### Prerequisites
- Node.js 18+ on your server
- Nginx (or any reverse proxy with WebSocket support)
- Build machine with ≥2GB RAM (Vite build OOMs on 1GB)

### 1. Build locally

```bash
git clone https://github.com/EveryInc/proof-sdk.git
cd proof-sdk
npm install
npm run build   # creates dist/ — requires ~1.5GB RAM
```

### 2. Deploy to server

```bash
# Rsync to server (skip node_modules — reinstall on server)
rsync -az --exclude=.git --exclude=node_modules --exclude=.env \
  ./ user@server:/var/www/proof-editor/

# Install production deps on server
ssh user@server "cd /var/www/proof-editor && npm install --omit=dev"

# tsx (TypeScript runner) is a devDependency, but the server needs it at runtime.
# Install it globally so the systemd ExecStart can find it:
ssh user@server "npm install -g tsx"
```

### 3. Environment

```bash
# /var/www/proof-editor/.env
PORT=4100
NODE_ENV=production
DATABASE_PATH=/var/www/proof-editor/data/proof.db
PROOF_CORS_ALLOW_ORIGINS=https://your-domain.com
PROOF_PUBLIC_BASE_URL=https://your-domain.com
PROOF_PUBLIC_ORIGIN=https://your-domain.com
PROOF_TRUST_PROXY_HEADERS=true
VITE_ENABLE_TELEMETRY=false

# Collaboration (required for real-time editing)
PROOF_COLLAB_SIGNING_SECRET=<openssl rand -hex 32>
COLLAB_ATTACH_TO_MAIN_HTTP=true
COLLAB_PUBLIC_BASE_URL=wss://your-domain.com/collab
```

### 4. Systemd service

```ini
[Unit]
Description=Proof Editor
After=network.target

[Service]
User=deploy
WorkingDirectory=/var/www/proof-editor
EnvironmentFile=/var/www/proof-editor/.env
ExecStart=/usr/bin/npx tsx server/index.ts
Restart=always
RestartSec=5
MemoryMax=400M

[Install]
WantedBy=multi-user.target
```

### 5. Nginx

```nginx
server {
    server_name your-domain.com;

    # Serve built frontend assets directly (bypass Express)
    location /assets/ {
        alias /var/www/proof-editor/dist/assets/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # Everything else → Express (with WebSocket upgrade support)
    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        client_max_body_size 10m;
    }
}

# Required in nginx.conf http{} block:
# map $http_upgrade $connection_upgrade {
#     default upgrade;
#     ""      close;
# }
```

Then: `certbot --nginx -d your-domain.com`

## Gotchas We Hit

### 1. Vite build OOMs on small VPS

The frontend build (`npm run build`) needs ~1.5GB RAM. A 1GB Nanode will OOM with `FATAL ERROR: Ineffective mark-compacts near heap limit`. **Build locally, rsync artifacts.**

### 2. `dist/assets/` not served by Express

Express serves `public/` as static, but the built editor JS lives in `dist/`. Without Nginx (or similar) serving `dist/assets/` directly, you'll get 404 on `editor.js` and the browser will show a blank page with console errors about MIME type.

### 3. Collaboration WebSocket blocked by share WebSocket

**This is a bug in the current codebase.** `WebSocketServer({ server, path: '/ws' })` in `index.ts` captures ALL HTTP upgrade events and rejects any path that isn't `/ws` with a 400 — including `/collab` requests from the collaboration runtime.

Symptoms: editor loads, health check shows `collab.enabled: true`, but browser console shows `WebSocket connection failed` on the `/collab` path.

Fix (PR: [rdhyee/proof-sdk#1](https://github.com/rdhyee/proof-sdk/pull/1)):
- Switch share WSS to `noServer: true`
- Add manual upgrade routing for `/ws` and `/collab`
- Set `COLLAB_ATTACH_TO_MAIN_HTTP=true` to bind collab to the main HTTP server

### 4. Three collab modes — only one works for single-port

The collab runtime has three modes that aren't documented:

| Mode | Function | WebSocket? | Use case |
|------|----------|------------|----------|
| `startCollabRuntimeEmbedded` | State management only | **No** | Platform with external WS proxy |
| `startCollabRuntimeAttached` | Attaches to main HTTP server | Yes, on `/collab` | **Self-hosting (use this)** |
| `startCollabRuntime` | Own HTTP server on `COLLAB_PORT` | Yes, separate port | Multi-process deploys |

`index.ts` hardcodes `startCollabRuntimeEmbedded`, which reports `enabled: true` but doesn't serve WebSocket connections. The health endpoint doesn't distinguish "state management running" from "WebSocket actually accepting connections" — this is misleading.

### 5. API field is `markdown`, not `content`

`POST /documents` expects `{"markdown": "..."}`, not `{"content": "..."}`. Returns generic HTML `400 Bad Request` rather than a JSON error if the body shape is wrong, making it hard to debug.

### 6. Legacy create mode

Non-localhost deployments default to `warn` mode for `POST /documents`, adding deprecation headers. Set `PROOF_LEGACY_CREATE_MODE=allow` if you want clean responses.

## Agent Experience (AX) Observations

As an AI agent deploying and interacting with Proof:

### What works well
- **Agent bridge API** is well-designed — presence, state, snapshot, edit/v2, comments, suggestions
- **Provenance tracking** is the killer feature — green (human) vs purple (AI) at character level
- **`/.well-known/agent.json`** and `/agent-docs` are excellent discovery mechanisms
- **Token-based auth** is simple and agent-friendly

### What could improve for agent deployability
- **No deployment docs** — the README covers the API but not how to run the server in production
- **Health endpoint is misleading** — `collab.enabled: true` when WebSocket isn't actually serving
- **No `/setup` or self-host guidance endpoint** — agents can't discover what env vars are needed
- **Error messages for `POST /documents`** — returns HTML 400 instead of JSON when body shape is wrong
- **Three undocumented collab modes** — an agent (or human) has to read 5000 lines of `collab.ts` to understand the topology options
- **`dist/` not served by Express in production** — requires external static file serving that isn't documented

### The meta-point

Proof is built for excellent *writing* AX — provenance tracking, the agent HTTP bridge, and the `/edit/v2` API are thoughtful and well-implemented. But the *deployment* AX — getting Proof running as an agent-accessible service on your own infrastructure — has gaps. For a tool whose value proposition is AI-human collaboration, making it easy for AI agents to set up and connect to self-hosted instances would close the loop.

## Architecture Reference

```
Browser → Nginx (443) → Express (4100)
                ↓              ↓
         /assets/ (static)   /ws (share WebSocket)
                             /collab (collab WebSocket)
                             /d/:slug (editor SPA)
                             /documents/* (API)
                             /api/agent/* (agent bridge)

Data: SQLite (WAL mode) at DATABASE_PATH
Collab: Yjs CRDT via Hocuspocus, synced to SQLite
```

## Files

| What | Where |
|------|-------|
| Ansible playbook | `~/C/src/myinfonet-infra/infrastructure/ansible/playbooks/proof-editor.yml` |
| Removal playbook | `~/C/src/myinfonet-infra/infrastructure/ansible/playbooks/proof-editor-remove.yml` |
| Deploy script | `~/C/src/myinfonet-infra/deploy-proof-editor.sh` |
| CC Skill | `~/.claude/skills/proofeditor/SKILL.md` |
| Obsidian note | `~/obsidian/Main/Proof Editor Self-Hosting.md` |
| VPS env | `/var/www/proof-editor/.env` (on Linode) |
| VPS data | `/var/www/proof-editor/data/proof.db` (on Linode) |
