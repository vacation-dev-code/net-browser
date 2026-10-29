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
//
// The Claude pane (ai/): a terminal running Claude Code beside the page
// (ai/terminal.js), plus browser tools it uses to read, point at and
// operate the active tab with its own visible cursor (ai/browser-tools.js).

const { app, BrowserWindow, Menu, session, ipcMain, clipboard, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const browserTools = require('./ai/browser-tools');
const terminal = require('./ai/terminal');

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
//   * Ctrl/⌘+1…9 → select tab 1…9, and Ctrl+` → show/hide the Claude
//     pane (⌃` on macOS, where ⌘` cycles windows). Caught here, before
//     the page sees the key, so they work whichever page has focus.
//   * a right-click menu (Electron shows none by default): on a link,
//     open in new tab / copy link; then cut / copy / paste as the
//     selection and the field under the pointer allow.
// <webview> tabs also get:
//   * pointer forwarding. A guest swallows mouse events, so once a site
//     is loaded the UI page never sees the pointer over it, and the
//     hover-reveal tabs pane would only open on the start page. Guest
//     coordinates are relative to the page area beside the Claude pane,
//     which is what renderer.js measures in. Claude's own mouse events
//     are not forwarded: its clicks must not pop the pane.
//   * target=_blank links and window.open() as tabs, not bare windows.
app.on('web-contents-created', (_event, contents) => {
  const type = contents.getType();
  if (type !== 'window' && type !== 'webview') return;
  const ui = () => {
    const host = type === 'webview' ? contents.hostWebContents : contents;
    return host && !host.isDestroyed() ? host : null;
  };

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const plain = !input.alt && !input.shift;
    const ctrl = input.control && !input.meta;
    const mod = process.platform === 'darwin' ? input.meta && !input.control : ctrl;
    if (plain && mod && /^[1-9]$/.test(input.key)) {
      event.preventDefault();
      ui()?.send('menu-action', `select-tab-${input.key}`);
    } else if (plain && ctrl && input.code === 'Backquote') {
      event.preventDefault();
      ui()?.send('menu-action', 'toggle-ai');
    } else if (type === 'window' && process.platform !== 'darwin' && plain && ctrl && input.code === 'KeyQ'
      && terminal.isTerminalFocused(BrowserWindow.fromWebContents(contents)?.id)) {
      // Menu shortcuts are off while the terminal has focus
      // (ai/terminal.js), but Ctrl+Q should still quit.
      event.preventDefault();
      app.quit();
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
    if (browserTools.isSynthetic(contents.id)) return;
    if (input.type === 'mouseMove') ui()?.send('guest-pointer', { x: input.x, y: input.y });
    // The user clicked into a page: after Claude acts, the keyboard
    // stays here instead of jumping back to the terminal.
    else if (input.type === 'mouseDown') {
      const win = ui() && BrowserWindow.fromWebContents(ui());
      if (win) terminal.userLeftTerminal(win.id);
    }
  });
  contents.setWindowOpenHandler(({ url, disposition }) => {
    ui()?.send('open-in-new-tab', url, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  });
});

// launch: this is a window Net Browser opened at startup, where the
// Claude pane opens by itself if ⋯ → Settings says so. Windows opened
// later start without it, so each does not start a Claude session.
function createWindow({ launch = false } = {}) {
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

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), launch ? { query: { launch: '1' } } : {});
  return win;
}

// Native menu, mainly so keyboard shortcuts work even when a <webview>
// has focus (renderer keydown listeners do NOT fire then). Items act on
// the window they are used in, which Electron passes to click().
function buildMenu() {
  const send = (action) => (_item, win) => win?.webContents.send('menu-action', action);
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
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send('new-tab') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
      ],
    },
    // macOS only routes ⌘C / ⌘V / ⌘X / ⌘A through an Edit menu — without
    // one they do nothing, in pages and in the terminal alike.
    ...(process.platform === 'darwin' ? [{ role: 'editMenu' }] : []),
    {
      label: 'View',
      submenu: [
        { label: 'Go to URL…', accelerator: 'CmdOrCtrl+L', click: send('go-to-url') },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: send('reload') },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: send('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: send('forward') },
        { type: 'separator' },
        // Shown here, handled in before-input-event above, so it works
        // while the terminal has focus too.
        { label: 'Claude Pane', accelerator: 'Ctrl+`', registerAccelerator: false, click: send('toggle-ai') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

  // Claude pane: browser tools first, so the terminal can hand Claude
  // Code their address. If they fail, the terminal still works.
  try {
    await browserTools.start(app.getPath('userData'));
  } catch (err) {
    console.error('Net Browser: Claude\'s browser tools failed to start:', err.message);
  }
  terminal.attach({ mcpConfig: browserTools.mcpConfig });

  // Renderer asks: is the blocker actually on, and what is it?
  ipcMain.handle('blocker-status', blockerStatus);

  // macOS traffic lights are native, not part of the page, so they
  // follow the tabs pane by hand: shown only while it is open, and
  // moved into its top row on whichever edge it sits. offsetLeft and
  // offsetRight: where the page area starts and ends beside the Claude pane.
  ipcMain.handle('window-buttons', (event, { visible, side, paneWidth, inset, offsetLeft = 0, offsetRight = 0 }) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || process.platform !== 'darwin') return;
    const [width] = w.getContentSize();
    const x = side === 'left' ? offsetLeft + inset + 20 : width - offsetRight - inset - paneWidth + 20;
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

  buildMenu();
  createWindow({ launch: true });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ launch: true });
  });
});

app.on('will-quit', () => browserTools.stop());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
