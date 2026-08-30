import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { HIGHLIGHT_COLORS } from '../src/highlightColors';
import { getStore } from './store';

/**
 * The app's own File/Edit/View/Window menu. Electron draws a default one for
 * free until something calls `Menu.setApplicationMenu` — the moment this does,
 * that default is gone, so the template below rebuilds the standard roles
 * (quit, undo/redo, cut/copy/paste, reload, zoom, window list, …) alongside
 * the one addition this app actually needs: View → Highlight Color.
 */

function broadcastHighlightColor(id: string) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('settings:highlightColor', id);
  }
}

function selectHighlightColor(id: string) {
  getStore().saveSettings({ highlightColor: id });
  broadcastHighlightColor(id);
  // Rebuilt so the radio check mark moves to the newly picked color.
  buildMenu();
}

export function buildMenu() {
  const current = getStore().settings().highlightColor;

  const highlightSubmenu: MenuItemConstructorOptions[] = HIGHLIGHT_COLORS.map((color) => ({
    label: color.label,
    type: 'radio',
    checked: color.id === current,
    click: () => selectHighlightColor(color.id),
  }));

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [process.platform === 'darwin' ? { role: 'close' as const } : { role: 'quit' as const }],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Highlight Color', submenu: highlightSubmenu },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
