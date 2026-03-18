import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { PtyManager } from './pty-manager';
import { BrowserWindow } from 'electron';
import os from 'node:os';

let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
const WEB_PORT = 3456;

// Store recent output per session for new WebSocket clients
export const sessionOutputBuffers = new Map<string, string[]>();
const MAX_BUFFER_LINES = 200;

// Track which sessions are waiting
export const waitingSessions = new Set<string>();

// All connected WS clients
const wsClients = new Set<WebSocket>();

export function startWebServer(
  ptyManager: PtyManager,
  getWindow: () => BrowserWindow | null,
): void {
  httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHTML());
    } else if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    wsClients.add(ws);

    // Send current state
    const state = {
      type: 'init',
      sessions: Array.from(sessionOutputBuffers.entries()).map(([id, lines]) => ({
        id,
        output: lines.join('\n'),
        waiting: waitingSessions.has(id),
      })),
    };
    ws.send(JSON.stringify(state));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'send-keys' && msg.sessionId && msg.text) {
          ptyManager.write(msg.sessionId, msg.text);
        }
      } catch {}
    });

    ws.on('close', () => {
      wsClients.delete(ws);
    });
  });

  httpServer.listen(WEB_PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log(`ymux dashboard: http://${ip}:${WEB_PORT}`);
  });
}

export function stopWebServer(): void {
  if (wss) { wss.close(); wss = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
}

// Called from pty-manager when data arrives
export function broadcastPtyData(sessionId: string, data: string): void {
  // Buffer output
  if (!sessionOutputBuffers.has(sessionId)) {
    sessionOutputBuffers.set(sessionId, []);
  }
  const buf = sessionOutputBuffers.get(sessionId)!;
  const lines = data.split('\n');
  for (const line of lines) {
    buf.push(line);
    if (buf.length > MAX_BUFFER_LINES) buf.shift();
  }

  // Broadcast to WS clients
  const msg = JSON.stringify({ type: 'output', sessionId, data });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

export function broadcastSessionExit(sessionId: string): void {
  sessionOutputBuffers.delete(sessionId);
  waitingSessions.delete(sessionId);
  const msg = JSON.stringify({ type: 'exit', sessionId });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function broadcastWaitingState(sessionId: string, waiting: boolean): void {
  if (waiting) {
    waitingSessions.add(sessionId);
  } else {
    waitingSessions.delete(sessionId);
  }
  const msg = JSON.stringify({ type: 'waiting', sessionId, waiting });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function broadcastNewSession(sessionId: string): void {
  sessionOutputBuffers.set(sessionId, []);
  const msg = JSON.stringify({ type: 'new-session', sessionId });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>ymux</title>
<style>
:root {
  --bg: #0f0f14;
  --bg2: #16161e;
  --bg3: #1a1b26;
  --text: #c0caf5;
  --text2: #7982a9;
  --muted: #565f89;
  --accent: #7aa2f7;
  --accent-dim: rgba(122,162,247,0.15);
  --warning: #e0af68;
  --warning-dim: rgba(224,175,104,0.15);
  --border: rgba(255,255,255,0.06);
  --danger: #f7768e;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
  padding-bottom: env(safe-area-inset-bottom, 20px);
}
.header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}
.header h1 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.5px;
}
.header h1 span { color: var(--accent); }
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #9ece6a;
  box-shadow: 0 0 6px #9ece6a;
}
.status-dot.disconnected { background: var(--danger); box-shadow: 0 0 6px var(--danger); }
.panes { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.pane-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  transition: border-color 0.2s;
}
.pane-card.waiting {
  border-color: var(--warning);
  animation: pulse-border 2s ease-in-out infinite;
}
@keyframes pulse-border {
  0%, 100% { border-color: rgba(224,175,104,0.3); }
  50% { border-color: var(--warning); box-shadow: 0 0 20px rgba(224,175,104,0.15); }
}
.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg3);
  border-bottom: 1px solid var(--border);
}
.pane-id {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  font-family: Menlo, monospace;
}
.pane-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.pane-badge.waiting {
  background: var(--warning-dim);
  color: var(--warning);
}
.pane-badge.running {
  background: var(--accent-dim);
  color: var(--accent);
}
.pane-output {
  padding: 10px 14px;
  font-family: Menlo, 'HackGen Console', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text2);
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  -webkit-overflow-scrolling: touch;
}
.pane-input-area {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg3);
}
.pane-input {
  flex: 1;
  height: 38px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 14px;
  padding: 0 14px;
  outline: none;
  font-family: Menlo, 'HackGen Console', monospace;
  transition: border-color 0.2s;
}
.pane-input:focus { border-color: var(--accent); }
.pane-send {
  height: 38px;
  padding: 0 18px;
  background: var(--accent);
  color: var(--bg);
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}
.pane-send:active { opacity: 0.7; }
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--muted);
  text-align: center;
}
.empty-state .icon { font-size: 40px; margin-bottom: 12px; opacity: 0.5; }
.empty-state p { font-size: 14px; }
</style>
</head>
<body>
<div class="header">
  <h1><span>y</span>mux</h1>
  <div class="status-dot" id="statusDot"></div>
</div>
<div class="panes" id="panes">
  <div class="empty-state" id="emptyState">
    <div class="icon">&#9000;</div>
    <p>Connecting...</p>
  </div>
</div>
<script>
const panesEl = document.getElementById('panes');
const statusDot = document.getElementById('statusDot');
const emptyState = document.getElementById('emptyState');
const paneData = new Map();
let ws;

function stripAnsi(str) {
  return str.replace(/\\x1b\\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\\x1b\\][^\\x07]*\\x07/g, '')
    .replace(/[\\x00-\\x09\\x0b-\\x0c\\x0e-\\x1f]/g, '')
    .replace(/\\x1b[()][0-9A-B]/g, '');
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen = () => {
    statusDot.className = 'status-dot';
  };
  ws.onclose = () => {
    statusDot.className = 'status-dot disconnected';
    setTimeout(connect, 3000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'init') {
      paneData.clear();
      for (const s of msg.sessions) {
        paneData.set(s.id, { output: s.output, waiting: s.waiting });
      }
      render();
    } else if (msg.type === 'output') {
      if (!paneData.has(msg.sessionId)) {
        paneData.set(msg.sessionId, { output: '', waiting: false });
      }
      const p = paneData.get(msg.sessionId);
      p.output += msg.data;
      // Keep last ~5000 chars
      if (p.output.length > 5000) p.output = p.output.slice(-5000);
      updatePaneOutput(msg.sessionId);
    } else if (msg.type === 'waiting') {
      if (paneData.has(msg.sessionId)) {
        paneData.get(msg.sessionId).waiting = msg.waiting;
        render();
      }
    } else if (msg.type === 'new-session') {
      paneData.set(msg.sessionId, { output: '', waiting: false });
      render();
    } else if (msg.type === 'exit') {
      paneData.delete(msg.sessionId);
      render();
    }
  };
}

function render() {
  if (paneData.size === 0) {
    emptyState.style.display = 'flex';
    emptyState.querySelector('p').textContent = 'No active panes';
    // Remove old pane cards
    panesEl.querySelectorAll('.pane-card').forEach(el => el.remove());
    return;
  }
  emptyState.style.display = 'none';

  const existing = new Set();
  for (const [id, data] of paneData) {
    existing.add(id);
    let card = document.getElementById('pane-' + id);
    if (!card) {
      card = createPaneCard(id);
      panesEl.appendChild(card);
    }
    card.className = 'pane-card' + (data.waiting ? ' waiting' : '');
    const badge = card.querySelector('.pane-badge');
    badge.className = 'pane-badge ' + (data.waiting ? 'waiting' : 'running');
    badge.textContent = data.waiting ? 'Waiting' : 'Running';
  }

  // Remove cards for deleted sessions
  panesEl.querySelectorAll('.pane-card').forEach(el => {
    const id = el.id.replace('pane-', '');
    if (!existing.has(id)) el.remove();
  });
}

function updatePaneOutput(sessionId) {
  const el = document.getElementById('output-' + sessionId);
  if (!el) { render(); return; }
  const data = paneData.get(sessionId);
  if (!data) return;
  // Show last portion
  const lines = data.output.split('\\n').slice(-80);
  el.textContent = lines.join('\\n');
  el.scrollTop = el.scrollHeight;
}

function createPaneCard(id) {
  const card = document.createElement('div');
  card.className = 'pane-card';
  card.id = 'pane-' + id;
  const data = paneData.get(id);
  card.innerHTML = \`
    <div class="pane-header">
      <span class="pane-id">\${id}</span>
      <span class="pane-badge \${data?.waiting ? 'waiting' : 'running'}">\${data?.waiting ? 'Waiting' : 'Running'}</span>
    </div>
    <div class="pane-output" id="output-\${id}">\${data?.output || ''}</div>
    <div class="pane-input-area">
      <input class="pane-input" id="input-\${id}" placeholder="Send message..." autocomplete="off" autocapitalize="off">
      <button class="pane-send" onclick="sendToPane('\${id}')">Send</button>
    </div>
  \`;
  const input = card.querySelector('.pane-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { sendToPane(id); }
  });
  return card;
}

function sendToPane(sessionId) {
  const input = document.getElementById('input-' + sessionId);
  if (!input || !input.value.trim()) return;
  ws.send(JSON.stringify({ type: 'send-keys', sessionId, text: input.value + '\\n' }));
  input.value = '';
}

connect();
</script>
</body>
</html>`;
}
