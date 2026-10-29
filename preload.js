// Preload for the Net Browser UI window only (NOT for web pages).
// Web pages run in <webview> tabs with no Node access and no preload
// from this file, so sites cannot reach Electron APIs through it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('minimal', {
  platform: process.platform,
  onMenuAction: (callback) => ipcRenderer.on('menu-action', (_event, action) => callback(action)),
  getBlockerStatus: () => ipcRenderer.invoke('blocker-status'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  toggleBlocker: () => ipcRenderer.invoke('toggle-blocker'),
  // Links a page asked to open in a new tab: right-click → Open Link
  // in New Tab, target=_blank, window.open() (see main.js).
  onOpenInNewTab: (callback) => ipcRenderer.on('open-in-new-tab', (_event, url, options) => callback(url, options)),
  // History menu → a page, opened in the current tab.
  onNavigateActive: (callback) => ipcRenderer.on('navigate-active', (_event, url) => callback(url)),
  // Tabs pane: pointer position over the <webview> tabs (see main.js),
  // and the macOS traffic lights following the pane.
  onGuestPointer: (callback) => ipcRenderer.on('guest-pointer', (_event, point) => callback(point)),
  setWindowButtons: (visible, side, paneWidth, inset) => ipcRenderer.invoke('window-buttons', { visible, side, paneWidth, inset }),
});
