import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { PtyCreateOptions } from '../shared/types';
import { SOCKET_PATH } from './socket-server';
import { broadcastPtyData, broadcastNewSession, broadcastSessionExit } from './web-server';

interface PtySession {
  process: pty.IPty;
  cwd: string;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private nextId = 0;

  create(win: BrowserWindow, options: PtyCreateOptions = {}): string {
    const id = `pty-${this.nextId++}`;
    const shell = options.shell || this.getDefaultShell();
    const cwd = options.cwd || process.env.HOME || '/';
    const cols = options.cols || 80;
    const rows = options.rows || 24;

    // Inject YMUX environment variable so child processes know they're in ymux
    const env = {
      ...process.env,
      YMUX: '1',
      YMUX_SOCKET: '/tmp/ymux.sock',
    } as Record<string, string>;

    // If a command was specified, wrap it in a shell invocation
    const args: string[] = [];
    if (options.command) {
      args.push('-c', options.command);
    }

    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });

    proc.onData((data: string) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PTY_DATA, id, data);
      }
      broadcastPtyData(id, data);
    });

    proc.onExit(({ exitCode }) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PTY_EXIT, id, exitCode);
      }
      this.sessions.delete(id);
      broadcastSessionExit(id);
    });

    this.sessions.set(id, { process: proc, cwd });
    broadcastNewSession(id);
    return id;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.process.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.process.resize(cols, rows);
    } catch {
      // ignore resize errors on dead processes
    }
  }

  getProcessName(id: string): string | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    try {
      return session.process.process || null;
    } catch {
      return null;
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.process.kill();
      this.sessions.delete(id);
    }
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }

  private getDefaultShell(): string {
    if (process.platform === 'darwin') {
      return process.env.SHELL || '/bin/zsh';
    }
    if (process.platform === 'win32') {
      return 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }
}
