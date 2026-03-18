import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

// Use a fixed, well-known path for the socket
export const SOCKET_PATH = '/tmp/ymux.sock';

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

export function startSocketServer(onCommand: CommandHandler): void {
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
        onCommand(cmd).then((response) => {
          conn.write(JSON.stringify(response) + '\n', () => conn.end());
        }).catch((err) => {
          conn.write(JSON.stringify({ ok: false, error: String(err) }) + '\n', () => conn.end());
        });
      } catch {
        // Not complete JSON yet, wait for more data
      }
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

  server.on('error', (err) => {
    console.error('ymux socket server error:', err);
  });
}

export function stopSocketServer(): void {
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
