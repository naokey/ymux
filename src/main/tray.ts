import { Tray, Menu, nativeImage, BrowserWindow, app, ipcMain } from 'electron';
import { IPC } from '../shared/ipc-channels';

let tray: Tray | null = null;

export function createTray(getWindow: () => BrowserWindow | null): void {
  const size = 18;
  const canvas = Buffer.alloc(size * size * 4, 0);

  const pixels = [
    [2,2],[3,3],[4,4],[5,5],[6,6],[7,7],[8,8],
    [15,2],[14,3],[13,4],[12,5],[11,6],[10,7],[9,8],
    [8,8],[9,8],[8,9],[9,9],
    [8,10],[9,10],[8,11],[9,11],[8,12],[9,12],[8,13],[9,13],[8,14],[9,14],[8,15],[9,15],
    [3,2],[4,3],[5,4],[6,5],[7,6],[8,7],
    [14,2],[13,3],[12,4],[11,5],[10,6],[9,7],
  ];

  for (const [x, y] of pixels) {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      const offset = (y * size + x) * 4;
      canvas[offset] = 0;
      canvas[offset + 1] = 0;
      canvas[offset + 2] = 0;
      canvas[offset + 3] = 255;
    }
  }

  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('ymux');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show ymux',
      click: () => {
        const win = getWindow();
        if (win) { win.show(); win.focus(); }
      },
    },
    {
      label: 'New Window',
      click: () => {
        const win = getWindow();
        if (!win) { app.emit('activate'); } else { win.show(); win.focus(); }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit ymux',
      click: () => { app.quit(); },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    const win = getWindow();
    if (win) {
      if (win.isVisible()) { win.focus(); } else { win.show(); }
    }
  });

  // Listen for waiting count updates from renderer
  ipcMain.on(IPC.WAITING_COUNT, (_event, count: number) => {
    // Dock badge (red notification circle)
    if (count > 0) {
      app.dock?.setBadge(String(count));
    } else {
      app.dock?.setBadge('');
    }
    // Tray text
    if (!tray) return;
    if (count > 0) {
      tray.setTitle(` ${count}`, { fontType: 'monospacedDigit' });
    } else {
      tray.setTitle('');
    }
  });
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
