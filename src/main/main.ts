import { app, BrowserWindow, webContents, ipcMain } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { PtyManager } from './pty-manager';
import { registerIpcHandlers } from './ipc-handlers';
import { startSocketServer, stopSocketServer } from './socket-server';
import type { SocketCommand, SocketResponse } from './socket-server';
import { IPC } from '../shared/ipc-channels';
import { createTray, destroyTray } from './tray';
import { startWebServer, stopWebServer, broadcastWaitingState } from './web-server';
import { startTelegramBot, stopTelegramBot, notifyWaiting } from './telegram-bot';

const ptyManager = new PtyManager();
let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    backgroundColor: '#1c1c1c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const loadWithRetry = (retries = 10) => {
      mainWindow!.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch(() => {
        if (retries > 0) {
          setTimeout(() => loadWithRetry(retries - 1), 1000);
        }
      });
    };
    loadWithRetry();
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle webview new-window requests (target="_blank", window.open)
  // Electron webview tags create guest webContents; we deny popup creation
  // and let the renderer handle it via the 'new-window' event on the webview tag.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    // Security: disable node integration in webviews
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });

  // When a webview guest tries to open a new window, deny it
  // (the renderer's 'new-window' event handler will open it as a new browser tab)
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler(() => {
        return { action: 'deny' };
      });
    }
  });
};

registerIpcHandlers(ptyManager, () => mainWindow);

// Handle external commands via Unix socket
async function handleSocketCommand(cmd: SocketCommand): Promise<SocketResponse> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    return { ok: false, error: 'No active window' };
  }

  const cwd = cmd.cwd || process.env.HOME || '/';

  if (cmd.action === 'split') {
    const direction = cmd.direction || 'vertical';
    const sessionId = ptyManager.create(win, { cwd, command: cmd.command });

    // Tell renderer to split the active pane
    win.webContents.send(IPC.SPLIT_PANE, {
      direction,
      sessionId,
    });

    // Bring window to front
    win.show();
    win.focus();

    return { ok: true };
  }

  if (cmd.action === 'new-tab') {
    const sessionId = ptyManager.create(win, { cwd, command: cmd.command });

    // Tell renderer to create a new tab
    win.webContents.send(IPC.NEW_TAB, {
      sessionId,
    });

    win.show();
    win.focus();

    return { ok: true };
  }

  // --- Inter-pane communication ---

  if (cmd.action === 'send-keys') {
    const target = cmd.target ?? 0;
    const text = cmd.text || '';
    const requestId = crypto.randomUUID();
    win.webContents.send(IPC.SEND_KEYS, { target, text, requestId });
    return { ok: true };
  }

  if (cmd.action === 'capture-pane') {
    const target = cmd.target ?? 0;
    const lines = cmd.lines ?? 50;
    const requestId = crypto.randomUUID();

    return new Promise<SocketResponse>((resolve) => {
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(`${IPC.CAPTURE_PANE}:response`);
        resolve({ ok: false, error: 'Timeout waiting for capture-pane response' });
      }, 5000);

      ipcMain.once(`${IPC.CAPTURE_PANE}:response`, (_event, response: { requestId: string; data: string }) => {
        if (response.requestId === requestId) {
          clearTimeout(timeout);
          resolve({ ok: true, data: response.data });
        }
      });

      win.webContents.send(IPC.CAPTURE_PANE, { target, lines, requestId });
    });
  }

  if (cmd.action === 'list-panes') {
    const requestId = crypto.randomUUID();

    return new Promise<SocketResponse>((resolve) => {
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(`${IPC.LIST_PANES}:response`);
        resolve({ ok: false, error: 'Timeout waiting for list-panes response' });
      }, 5000);

      ipcMain.once(`${IPC.LIST_PANES}:response`, (_event, response: { requestId: string; panes: any[] }) => {
        if (response.requestId === requestId) {
          clearTimeout(timeout);
          resolve({ ok: true, panes: response.panes });
        }
      });

      win.webContents.send(IPC.LIST_PANES, { requestId });
    });
  }

  return { ok: false, error: `Unknown action: ${cmd.action}` };
}

// Forward session waiting state to web dashboard and Telegram
ipcMain.on(IPC.SESSION_WAITING, (_event, sessionId: string, waiting: boolean) => {
  broadcastWaitingState(sessionId, waiting);
  notifyWaiting(sessionId, waiting);
});

app.on('ready', () => {
  createWindow();
  startSocketServer(handleSocketCommand);
  createTray(() => mainWindow);
  startWebServer(ptyManager, () => mainWindow);
  startTelegramBot(ptyManager, () => mainWindow);
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  stopSocketServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  ptyManager.killAll();
  stopSocketServer();
  stopWebServer();
  stopTelegramBot();
  destroyTray();
});
