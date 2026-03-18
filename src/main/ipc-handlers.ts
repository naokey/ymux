import { ipcMain, BrowserWindow } from 'electron';
import { PtyManager } from './pty-manager';
import { IPC } from '../shared/ipc-channels';
import type { PtyCreateOptions } from '../shared/types';

export function registerIpcHandlers(ptyManager: PtyManager, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.PTY_CREATE, (_event, options: PtyCreateOptions) => {
    const win = getWindow();
    if (!win) return null;
    return ptyManager.create(win, options);
  });

  ipcMain.handle(IPC.PTY_WRITE, (_event, id: string, data: string) => {
    ptyManager.write(id, data);
  });

  ipcMain.handle(IPC.PTY_RESIZE, (_event, id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows);
  });

  ipcMain.handle(IPC.PTY_KILL, (_event, id: string) => {
    ptyManager.kill(id);
  });

  ipcMain.handle(IPC.PTY_GET_PROCESS, (_event, id: string) => {
    return ptyManager.getProcessName(id);
  });
}
