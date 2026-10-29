// Net Browser v0.1 — main process.
//
// Engine choice, in one paragraph: the pre-v0.1 Swift/WKWebView version
// (archived in archive/swift-wkwebview/) could only do a uBlock-*style*
// blocker, because WKWebView cannot load extensions or see requests.
// v0.1 moves to Electron/Chromium, where the main process sees every
// request a tab makes and can cancel it. That is the whole point of v0.1.
//
// Which blocker, exactly — read this before changing it:
//   * NOT a Chrome extension. An earlier v0.1 build loaded uBlock Origin
//     Lite (MV3) unpacked. It "loads" without error and then blocks
//     nothing: Electron has no chrome.permissions API, so Lite's service
//     worker throws on startup, and Electron does not apply its
//     declarativeNetRequest rulesets either. Tested Oct 2026: with Lite
//     loaded, adsbygoogle.js still loaded. Full MV2 uBlock Origin is no
//     option either — current Chromium removed MV2 entirely.
//   * v0.1 uses @ghostery/adblocker-electron instead: a filter engine
//     that reads uBlock Origin / EasyList syntax, cancels requests from
//     the session's webRequest hooks, and hides page elements through a
//     frame preload (cosmetic filters). Lists: Ghostery's prebuilt
//     ads + tracking set (EasyList, EasyPrivacy, uBlock filters and
//     privacy lists), cached in userData and refreshed weekly.
//   * It adapts to YouTube's anti-adblock changes slower than full
//     uBlock Origin on Firefox, and no Chromium-side blocker can
//     promise "never a YouTube ad" in Oct 2026. If that is the #1
//     requirement, Firefox + full uBlock Origin is still the obvious
//     v0.2 fork to discuss.
//
// Wiring rules:
//   * The blocker goes on the exact session the <webview> tabs use:
//     partition "persist:minimal". Enabling it on defaultSession alone
//     would do nothing for the tabs.
//   * Electron allows ONE listener per webRequest event per session.
//     Anything else registering onBeforeRequest / onHeadersReceived on
//     that partition silently replaces the blocker.

const { app, BrowserWindow, Menu, session, ipcMain, clipboard, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

const PARTITION = 'persist:minimal';
const LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let blocker = null;

async function loadBlocker() {
  const cachePath = path.join(app.getPath('userData'), 'adblocker-engine.bin');
  // The cache is only rebuilt when it cannot be read, so age it out
  // by hand — otherwise the filter lists would never update.
  try {
    if (Date.now() - fs.statSync(cachePath).mtimeMs > LIST_MAX_AGE_MS) fs.rmSync(cachePath);
  } catch {}
  return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: cachePath,
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  });
}

function blockerStatus() {
  return {
    present: blocker !== null,
    enabled: blocker !== null && blocker.isBlockingEnabled(session.fromPartition(PARTITION)),
    name: 'Ghostery adblocker (uBlock Origin / EasyList filters)',
  };
}

// Every page — the UI and each <webview> tab — gets:
//   * Ctrl/⌘+1…9 → select tab 1…9. Caught here, before the page sees
//     the key, so it works whichever page has focus.
//   * a right-click menu (Electron shows none by default): on a link,
//     open in new tab / copy link; then cut / copy / paste as the
//     selection and the field under the pointer allow.
// <webview> tabs also get:
//   * pointer forwarding. A guest swallows mouse events, so once a site
//     is loaded the UI page never sees the pointer over it, and the
//     hover-reveal tabs pane would only open on the start page. The tabs
//     fill the window from (0, 0), so guest coordinates are window ones.
//   * target=_blank links and window.open() as tabs, not bare windows.
app.on('web-contents-created', (_event, contents) => {
  const type = contents.getType();
  if (type !== 'window' && type !== 'webview') return;
  const ui = () => {
    const host = type === 'webview' ? contents.hostWebContents : contents;
    return host && !host.isDestroyed() ? host : null;
  };

  contents.on('before-input-event', (event, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (input.type === 'keyDown' && mod && !input.alt && !input.shift && /^[1-9]$/.test(input.key)) {
      event.preventDefault();
      ui()?.send('menu-action', `select-tab-${input.key}`);
    }
  });

  contents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => ui()?.send('open-in-new-tab', params.linkURL, { background: true }) },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
      );
    }
    const { canCut, canCopy, canPaste } = params.editFlags;
    const edit = [];
    if (params.isEditable && canCut) edit.push({ label: 'Cut', click: () => contents.cut() });
    if (canCopy) edit.push({ label: 'Copy', click: () => contents.copy() });
    if (params.isEditable && canPaste) edit.push({ label: 'Paste', click: () => contents.paste() });
    if (items.length && edit.length) items.push({ type: 'separator' });
    items.push(...edit);
    const host = ui();
    if (items.length && host) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(host) });
  });

  if (type !== 'webview') return;
  contents.on('input-event', (_e, input) => {
    if (input.type === 'mouseMove') ui()?.send('guest-pointer', { x: input.x, y: input.y });
  });
  contents.setWindowOpenHandler(({ url, disposition }) => {
    ui()?.send('open-in-new-tab', url, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  });
});

function createWindow() {
  const isLinux = process.platform === 'linux';
  // Linux has no NSVisualEffectView / vibrancy, so the glass is
  // done in CSS (renderer/styles.css), not by the window system.
  // That is also why Linux gets a frameless window: with a native
  // frame, the OS title bar would add the top bar this design does
  // not have. Frameless + a drag region in the tabs pane's top row
  // is what lets the glass pane BE the title bar on Arch.
  // NET_BROWSER_OPAQUE=1 is the escape hatch for window managers
  // without a compositor: native frame, opaque window, CSS glass
  // falls back to a solid translucent panel (see styles.css).
  const opaque = process.env.NET_BROWSER_OPAQUE === '1';
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 480,
    minHeight: 320,
    // macOS: no title bar; the traffic lights show only while the
    // tabs pane is open, inside its top row (see 'window-buttons').
    titleBarStyle: isLinux ? undefined : 'hiddenInset',
    vibrancy: isLinux ? undefined : 'sidebar',
    frame: isLinux ? !opaque : true,
    transparent: isLinux ? !opaque : false,
    backgroundColor: isLinux && !opaque ? '#00000000' : '#ffffff',
    // Reuse the macOS icon on Linux too — Electron takes a PNG here.
    icon: path.join(__dirname, 'assets', 'net-browser-icon-1024.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required for <webview> tabs. See renderer/index.html for why
      // v0.1 uses <webview> and what v0.2 should replace it with.
      webviewTag: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Native menu, mainly so keyboard shortcuts work even when a
  // <webview> has focus (renderer keydown listeners do NOT fire then).
  const template = [
    {
      label: 'Net Browser',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => win.webContents.send('menu-action', 'new-tab') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => win.webContents.send('menu-action', 'close-tab') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Go to URL…', accelerator: 'CmdOrCtrl+L', click: () => win.webContents.send('menu-action', 'go-to-url') },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.send('menu-action', 'reload') },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => win.webContents.send('menu-action', 'back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => win.webContents.send('menu-action', 'forward') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return win;
}

app.whenReady().then(async () => {
  try {
    blocker = await loadBlocker();
    blocker.enableBlockingInSession(session.fromPartition(PARTITION));
    console.log('Net Browser v0.1: ad blocker on (Ghostery engine, ads + tracking lists)');
  } catch (err) {
    console.error('Net Browser v0.1: ad blocker failed to load:', err.message);
    console.error('The filter lists download on first launch — check the network, then restart.');
  }

  // Renderer asks: is the blocker actually on, and what is it?
  ipcMain.handle('blocker-status', blockerStatus);

  // macOS traffic lights are native, not part of the page, so they
  // follow the tabs pane by hand: shown only while it is open, and
  // moved into its top row on whichever edge it sits.
  ipcMain.handle('window-buttons', (event, { visible, side, paneWidth, inset }) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || process.platform !== 'darwin') return;
    const [width] = w.getContentSize();
    const x = side === 'left' ? inset + 20 : width - inset - paneWidth + 20;
    w.setWindowButtonPosition({ x, y: inset + 26 });
    w.setWindowButtonVisibility(visible);
  });

  // ⋯ → Settings → Theme: 'system' | 'light' | 'dark'. Setting
  // nativeTheme flips prefers-color-scheme for the UI AND for every
  // site that supports dark mode, plus native menus, all at once.
  ipcMain.handle('set-theme', (_event, theme) => {
    if (['system', 'light', 'dark'].includes(theme)) nativeTheme.themeSource = theme;
  });

  // Renderer ⋯ menu toggles the blocker on/off, then reloads tabs itself.
  ipcMain.handle('toggle-blocker', () => {
    if (blocker) {
      const ses = session.fromPartition(PARTITION);
      if (blocker.isBlockingEnabled(ses)) blocker.disableBlockingInSession(ses);
      else blocker.enableBlockingInSession(ses);
    }
    return blockerStatus();
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
