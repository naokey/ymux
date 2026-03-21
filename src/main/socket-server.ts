import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';

// Use a stable path inside the app's user data directory to avoid macOS /tmp cleanup.
// Falls back to /tmp/ymux.sock if the app data dir is unavailable.
function getSocketPath(): string {
  try {
    const userDataDir = app.getPath('userData'); // ~/Library/Application Support/ymux
    return path.join(userDataDir, 'ymux.sock');
  } catch {
    return '/tmp/ymux.sock';
  }
}

export const SOCKET_PATH = getSocketPath();

export interface SocketCommand {
  action: 'split' | 'new-tab' | 'send-keys' | 'capture-pane' | 'list-panes';
  direction?: 'horizontal' | 'vertical';
  command?: string;
  cwd?: string;
  target?: number; // pane index (0-based)
  text?: string;
  lines?: number;
}

export interface SocketResponse {
  ok: boolean;
  error?: string;
  paneId?: string;
  data?: string;
  panes?: Array<{ index: number; id: string; sessionId: string; kind: string; label: string; active: boolean }>;
}

type CommandHandler = (cmd: SocketCommand) => Promise<SocketResponse>;

let server: net.Server | null = null;
let currentHandler: CommandHandler | null = null;

export function startSocketServer(onCommand: CommandHandler): void {
  currentHandler = onCommand;
  createServer();
}

function createServer(): void {
  if (!currentHandler) return;

  // Clean up stale socket
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }

  server = net.createServer((conn) => {
    let data = '';
    let handled = false;

    conn.on('data', (chunk) => {
      data += chunk.toString();
      if (handled) return;
      try {
        const cmd: SocketCommand = JSON.parse(data);
        handled = true;
        currentHandler!(cmd).then((response) => {
          conn.write(JSON.stringify(response) + '\n', () => conn.end());
        }).catch((err) => {
          conn.write(JSON.stringify({ ok: false, error: String(err) }) + '\n', () => conn.end());
        });
      } catch {
        // Not complete JSON yet, wait for more data
      }
    });

    conn.on('error', (err) => {
      console.error('[ymux] Socket connection error:', err.message);
    });
  });

  server.listen(SOCKET_PATH, () => {
    console.log('ymux socket server listening on', SOCKET_PATH);
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch {
      // ignore
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error('[ymux] Socket server error:', err);
    // Attempt to recover by restarting the server
    if (server) {
      try { server.close(); } catch {}
      server = null;
    }
    console.log('[ymux] Restarting socket server in 1s...');
    setTimeout(() => createServer(), 1000);
  });

  server.on('close', () => {
    // If the server closed unexpectedly (not via stopSocketServer), restart it
    if (currentHandler && server !== null) {
      console.log('[ymux] Socket server closed unexpectedly, restarting in 1s...');
      server = null;
      setTimeout(() => createServer(), 1000);
    }
  });
}

// Periodically verify the socket file still exists (macOS /tmp cleanup, etc.)
const SOCKET_WATCHDOG_INTERVAL = 10_000; // 10 seconds
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!currentHandler) return;
    if (!server) return;
    try {
      fs.accessSync(SOCKET_PATH);
    } catch {
      // Socket file was deleted — restart the server
      console.log('[ymux] Socket file missing, restarting server...');
      try { server.close(); } catch {}
      server = null;
      createServer();
    }
  }, SOCKET_WATCHDOG_INTERVAL);
}

export function stopSocketServer(): void {
  currentHandler = null; // Prevent auto-restart
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (server) {
    server.close();
    server = null;
  }
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }
}

// Start watchdog when module loads
startWatchdog();
