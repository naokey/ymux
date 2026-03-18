import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export interface YmuxAPI {
  createSession: (options?: { shell?: string; cwd?: string; cols?: number; rows?: number; command?: string }) => Promise<string>;
  writeSession: (id: string, data: string) => void;
  resizeSession: (id: string, cols: number, rows: number) => void;
  killSession: (id: string) => Promise<void>;
  getSessionProcess: (id: string) => Promise<string | null>;
  sendWaitingCount: (count: number) => void;
  sendSessionWaiting: (sessionId: string, waiting: boolean) => void;
  onSessionData: (callback: (id: string, data: string) => void) => () => void;
  onSessionExit: (callback: (id: string, exitCode: number) => void) => () => void;
  onSplitPane: (callback: (data: { direction: string; sessionId: string }) => void) => () => void;
  onNewTab: (callback: (data: { sessionId: string }) => void) => () => void;
  onSendKeys: (callback: (data: { target: number; text: string; requestId: string }) => void) => () => void;
  onCapturePaneRequest: (callback: (data: { target: number; lines: number; requestId: string }) => void) => () => void;
  sendCapturePaneResponse: (requestId: string, data: string) => void;
  onListPanesRequest: (callback: (data: { requestId: string }) => void) => () => void;
  sendListPanesResponse: (requestId: string, panes: any[]) => void;
}

contextBridge.exposeInMainWorld('ymuxAPI', {
  createSession: (options = {}) => ipcRenderer.invoke(IPC.PTY_CREATE, options),

  writeSession: (id: string, data: string) => {
    ipcRenderer.invoke(IPC.PTY_WRITE, id, data);
  },

  resizeSession: (id: string, cols: number, rows: number) => {
    ipcRenderer.invoke(IPC.PTY_RESIZE, id, cols, rows);
  },

  killSession: (id: string) => ipcRenderer.invoke(IPC.PTY_KILL, id),

  getSessionProcess: (id: string) => ipcRenderer.invoke(IPC.PTY_GET_PROCESS, id),

  sendWaitingCount: (count: number) => {
    ipcRenderer.send(IPC.WAITING_COUNT, count);
  },

  sendSessionWaiting: (sessionId: string, waiting: boolean) => {
    ipcRenderer.send(IPC.SESSION_WAITING, sessionId, waiting);
  },

  onSessionData: (callback: (id: string, data: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data);
    ipcRenderer.on(IPC.PTY_DATA, handler);
    return () => ipcRenderer.removeListener(IPC.PTY_DATA, handler);
  },

  onSessionExit: (callback: (id: string, exitCode: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number) => callback(id, exitCode);
    ipcRenderer.on(IPC.PTY_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC.PTY_EXIT, handler);
  },

  onSplitPane: (callback: (data: { direction: string; sessionId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { direction: string; sessionId: string }) => callback(data);
    ipcRenderer.on(IPC.SPLIT_PANE, handler);
    return () => ipcRenderer.removeListener(IPC.SPLIT_PANE, handler);
  },

  onNewTab: (callback: (data: { sessionId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data);
    ipcRenderer.on(IPC.NEW_TAB, handler);
    return () => ipcRenderer.removeListener(IPC.NEW_TAB, handler);
  },

  onSendKeys: (callback: (data: { target: number; text: string; requestId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC.SEND_KEYS, handler);
    return () => ipcRenderer.removeListener(IPC.SEND_KEYS, handler);
  },

  onCapturePaneRequest: (callback: (data: { target: number; lines: number; requestId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC.CAPTURE_PANE, handler);
    return () => ipcRenderer.removeListener(IPC.CAPTURE_PANE, handler);
  },

  sendCapturePaneResponse: (requestId: string, data: string) => {
    ipcRenderer.send(`${IPC.CAPTURE_PANE}:response`, { requestId, data });
  },

  onListPanesRequest: (callback: (data: { requestId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC.LIST_PANES, handler);
    return () => ipcRenderer.removeListener(IPC.LIST_PANES, handler);
  },

  sendListPanesResponse: (requestId: string, panes: any[]) => {
    ipcRenderer.send(`${IPC.LIST_PANES}:response`, { requestId, panes });
  },
} satisfies YmuxAPI);
