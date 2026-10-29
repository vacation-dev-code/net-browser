// Net v0.1 — main process.
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

const { app, BrowserWindow, Menu, session, ipcMain, clipboard, nativeTheme, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const browserTools = require('./ai/browser-tools');
const terminal = require('./ai/terminal');

// The name macOS shows in the menu bar, Dock and About panel. Unpackaged
// (`npm start`), the Dock label still comes from Electron.app's
// Info.plist — assets/mac-app-name.js patches that before launch;
// Net.app (assets/build-mac-app.sh) carries its own.
app.setName('Net');
// setName also renames the userData folder. Keep the pre-rename one, so
// cookies, logins, settings and the filter-list cache carry over.
app.setPath('userData', path.join(app.getPath('appData'), 'net-browser'));
const ICON = path.join(__dirname, 'assets', 'net-icon-1024.png');

const PARTITION = 'persist:minimal';
const LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let blocker = null;

// --- History -----------------------------------------------------------
// Pages the tabs visit, newest first, for the History menu. Recorded
// here (every <webview> tab's navigations pass through main), kept in
// userData/history.json so it survives restarts. One entry per URL.
const HISTORY_MAX = 200;
const HISTORY_IN_MENU = 15;
let history = [];
let historySaveTimer = null;
let menuTimer = null;

function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}
function loadHistory() {
  try { history = JSON.parse(fs.readFileSync(historyPath(), 'utf8')).slice(0, HISTORY_MAX); } catch { history = []; }
}
function historyChanged() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => fs.promises.writeFile(historyPath(), JSON.stringify(history)).catch(() => {}), 1000);
  // A page load can fire several navigations; rebuild the menu once.
  clearTimeout(menuTimer);
  menuTimer = setTimeout(buildMenu, 300);
}
function recordVisit(url, title) {
  if (!/^https?:/i.test(url)) return;
  const old = history.find((h) => h.url === url);
  history = [{ url, title: title || old?.title || '', time: Date.now() }, ...history.filter((h) => h !== old)].slice(0, HISTORY_MAX);
  historyChanged();
}
function recordTitle(url, title) {
  const entry = history.find((h) => h.url === url);
  if (entry && title && entry.title !== title) {
    entry.title = title;
    historyChanged();
  }
}

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
//   * Ctrl/⌘+1…8 → select tab 1…8, Ctrl/⌘+9 → the last tab (as in
//     Safari and Chrome). Caught here, before the page sees the key,
//     so it works whichever page has focus.
//   * Ctrl+` toggles the Claude pane.
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
  contents.on('did-navigate', (_e, url) => recordVisit(url, contents.getTitle()));
  // Single-page sites (YouTube, GitHub) change pages without a load.
  contents.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) recordVisit(url, contents.getTitle()); });
  contents.on('page-title-updated', (_e, title) => recordTitle(contents.getURL(), title));
  contents.on('input-event', (_e, input) => {
    if (browserTools.isSynthetic(contents.id)) return;
    if (input.type === 'mouseMove') ui()?.send('guest-pointer', { x: input.x, y: input.y });
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
    // Opens maximized (below); shown once that is done, so the window
    // does not flash at 1100×750 first.
    show: false,
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
    icon: ICON,
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
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  return win;
}

// Native menu bar, mainly so keyboard shortcuts work even when a
// <webview> has focus (renderer keydown listeners do NOT fire then).
// One menu for the app; each item acts on whichever window is focused.
// Rebuilt whenever the history changes, for History's page list.
// No focused window (app inactive, e.g. Dock menu): the frontmost one.
function targetWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}
function send(action) {
  targetWindow()?.webContents.send('menu-action', action);
}
function historyLabel(entry) {
  let label = entry.title;
  if (!label) {
    try { label = new URL(entry.url).hostname; } catch { label = entry.url; }
  }
  return label.length > 60 ? label.slice(0, 59) + '…' : label;
}
function buildMenu() {
  const recent = history.slice(0, HISTORY_IN_MENU).map((entry) => ({
    label: historyLabel(entry),
    toolTip: entry.url,
    // Safari-style: a history item opens in the current tab.
    click: () => targetWindow()?.webContents.send('navigate-active', entry.url),
  }));
  const template = [
    {
      label: 'Net',
      submenu: [
        { role: 'about', label: 'About Net' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Net' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Net' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { label: 'Go to URL…', accelerator: 'CmdOrCtrl+L', click: () => send('go-to-url') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
      ],
    },
    // Without this menu, macOS has no ⌘C / ⌘V / ⌘A / ⌘Z at all: in
    // Electron those shortcuts ARE these menu items.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Go to URL…', accelerator: 'CmdOrCtrl+L', click: () => send('go-to-url') },
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => send('reload') },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send('forward') },
        { label: 'Claude Pane', accelerator: 'Ctrl+`', registerAccelerator: false, click: () => send('toggle-ai') },
        { type: 'separator' },
        // Zoom the page in the active tab, not the browser UI — hence
        // not the zoomIn / zoomOut roles, which act on the window.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-reset') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
        // ⌘+ (⇧⌘=) too, as in Safari and Chrome; hidden, same action.
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: () => send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send('forward') },
        { type: 'separator' },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('reopen-tab') },
        { type: 'separator' },
        { label: 'Recently Visited', enabled: false },
        ...(recent.length ? recent : [{ label: 'No History', enabled: false }]),
        { type: 'separator' },
        {
          label: 'Clear History…',
          enabled: history.length > 0,
          click: async () => {
            const w = targetWindow();
            const { response } = await dialog.showMessageBox(w, {
              type: 'question',
              buttons: ['Clear History', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              message: 'Clear all browsing history?',
              detail: 'This removes the pages listed in the History menu. Cookies and logins are kept.',
            });
            if (response === 0) {
              history = [];
              historyChanged();
            }
          },
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Net Help', click: () => send('show-help') },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('show-help') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  loadHistory();
  buildMenu();

  try {
    blocker = await loadBlocker();
    blocker.enableBlockingInSession(session.fromPartition(PARTITION));
    console.log('Net v0.1: ad blocker on (Ghostery engine, ads + tracking lists)');
  } catch (err) {
    console.error('Net v0.1: ad blocker failed to load:', err.message);
    console.error('The filter lists download on first launch — check the network, then restart.');
  }

  // Unpackaged, the Dock shows Electron's icon unless told otherwise.
  if (process.platform === 'darwin') app.dock.setIcon(ICON);
  app.setAboutPanelOptions({ applicationName: 'Net', applicationVersion: app.getVersion() });
  try {
    await browserTools.start(app.getPath('userData'));
  } catch (err) {
    console.error('Net Browser: Claude browser tools failed to start:', err.message);
  }
  terminal.attach({ mcpConfig: browserTools.mcpConfig });

  // Renderer asks: is the blocker actually on, and what is it?
  ipcMain.handle('blocker-status', blockerStatus);

  // macOS traffic lights are native, not part of the page, so they
  // follow the tabs pane by hand: shown only while it is open, and
  // moved into its top row on whichever edge it sits. The three
  // buttons are ~54px wide: from 24px into the pane they end at 78px,
  // and #pane-top's 80px left padding (styles.css) keeps the nav
  // capsule clear of them. Change one, change the other.
  ipcMain.handle('window-buttons', (event, { visible, side, paneWidth, inset, offsetLeft = 0, offsetRight = 0 }) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || process.platform !== 'darwin') return;
    const [width] = w.getContentSize();
    const x = side === 'left' ? offsetLeft + inset + 20 : width - offsetRight - inset - paneWidth + 20;
    // Visibility first: showing hidden buttons puts them back in the
    // default corner, so a position set before that is lost — which
    // left them over the page on every first open.
    w.setWindowButtonVisibility(visible);
    w.setWindowButtonPosition({ x, y: inset + 26 });
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

  createWindow({ launch: true });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({ launch: true });
  });
});

app.on('will-quit', () => browserTools.stop());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
