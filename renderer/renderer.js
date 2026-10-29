// Minimal v0.1 — UI process: tabs, top bar, sidebar, shortcuts.
//
// Why <webview> in v0.1, and what replaces it:
//   A <webview> is a DOM element, so the glass tabs pane (which
//   holds all of the browser's chrome) can float OVER the page with
//   z-index, exactly as the design specifies. A native BrowserView/WebContentsView sits
//   on top of the window's webContents and cannot be overlaid that
//   way — the sidebar would have to push the page sideways instead.
//   The cost: <webview> is deprecated in Electron. v0.2 should move
//   to WebContentsView + push sidebar, and this file is the only
//   place that change touches (main.js stays the same, apart from
//   moving tab creation there).
//
// Security posture for the <webview> tabs:
//   * partition="persist:minimal" — one persistent session, shared
//     by every tab, and the session main.js enables the ad blocker on.
//   * No Node, no preload from this app on the webviews. The only
//     preload there is the ad blocker's own (registered on the session
//     by main.js), which hides ad elements and exposes nothing to sites.

const $ = (id) => document.getElementById(id);
const SEARCH_URL = 'https://duckduckgo.com/?q=';
const tabsEl = $('tabs');
const startEl = $('start');

let tabs = []; // { id, title, url, favicon, view, isStart, ready }
let closedTabs = []; // { url, index }, most recent last — History → Reopen Closed Tab
let activeId = null;
let blocker = { present: false, enabled: false };
let hideTimer = null;
const MOD_LABEL = window.minimal?.platform === 'darwin' ? '⌘' : 'Ctrl+';

function urlFor(input) {
  const text = (input || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.includes('.') && !text.includes(' ')) return 'https://' + text;
  return SEARCH_URL + encodeURIComponent(text);
}

function activeTab() {
  return tabs.find((t) => t.id === activeId) || null;
}

function renderTabs() {
  const list = $('tab-list');
  list.innerHTML = '';
  tabs.forEach((tab, index) => {
    const row = document.createElement('button');
    row.className = 'tab-row' + (tab.id === activeId ? ' active' : '');
    row.title = tab.title || 'New Tab';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    // The site's own icon; the title's first letter until one arrives,
    // or if it fails to load.
    const letter = () => {
      avatar.classList.remove('has-icon');
      avatar.textContent = (tab.title || 'New Tab').trim().charAt(0).toUpperCase() || '·';
    };
    if (tab.favicon) {
      const icon = document.createElement('img');
      icon.src = tab.favicon;
      icon.alt = '';
      icon.addEventListener('error', () => { tab.favicon = null; letter(); });
      avatar.classList.add('has-icon');
      avatar.append(icon);
    } else {
      letter();
    }
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || 'New Tab';
    // Ctrl/⌘+1…9 hint; hovering the row swaps it for ×.
    const key = document.createElement('span');
    key.className = 'key';
    if (index < 9) key.textContent = MOD_LABEL + (index + 1);
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
    row.append(avatar, title, key, close);
    row.addEventListener('click', () => selectTab(tab.id));
    list.appendChild(row);
  });
  $('tab-count').textContent = tabs.length;
  // Show the right element: start page, or the active webview.
  const active = activeTab();
  startEl.classList.toggle('hidden', !(active && active.isStart));
  for (const tab of tabs) {
    if (tab.view) tab.view.classList.toggle('active', tab.id === activeId);
  }
  updateNavButtons();
}

function updateNavButtons() {
  const active = activeTab();
  // <webview> navigation methods only exist once the guest is ready
  // (dom-ready). Calling them earlier throws — at boot, that aborted
  // everything after newTab(), including the ad blocker status.
  const view = active && active.ready && active.view;
  $('back').disabled = !view || !view.canGoBack();
  $('forward').disabled = !view || !view.canGoForward();
}

function createWebview(tab) {
  const view = document.createElement('webview');
  view.setAttribute('partition', 'persist:minimal');
  view.setAttribute('allowpopups', '');
  tabsEl.appendChild(view);
  view.addEventListener('dom-ready', () => {
    tab.ready = true;
    updateNavButtons();
  });
  view.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || tab.title;
    renderTabs();
  });
  view.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    tab.isStart = false;
    // A new page: drop the old site's icon. page-favicon-updated
    // brings the new one; sites that declare none get the
    // conventional /favicon.ico, and the letter if that 404s.
    try { tab.favicon = new URL(e.url).origin + '/favicon.ico'; } catch { tab.favicon = null; }
    renderTabs();
  });
  view.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons.length && e.favicons[0] !== tab.favicon) {
      tab.favicon = e.favicons[0];
      renderTabs();
    }
  });
  view.addEventListener('did-finish-load', () => updateNavButtons());
  // target=_blank and window.open() arrive through main.js
  // (setWindowOpenHandler) as 'open-in-new-tab', like right-click.
  return view;
}

// background: open without switching to it (right-click → Open Link
// in New Tab), the way other browsers do.
function newTab(url, { background = false } = {}) {
  const tab = {
    id: 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    title: 'New Tab',
    url: url || null,
    view: null,
    isStart: !url,
  };
  tab.view = createWebview(tab);
  tabs.push(tab);
  if (url) tab.view.src = url;
  if (background) renderTabs();
  else selectTab(tab.id);
  return tab;
}

function selectTab(id) {
  activeId = id;
  const tab = activeTab();
  if (tab && tab.isStart) {
    // One start page serves every blank tab: clear what another tab
    // left typed in it.
    $('start-input').value = '';
    setTimeout(() => $('start-input').focus(), 0);
  }
  hideSidebarSoon();
  renderTabs();
}

function closeTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;
  const [tab] = tabs.splice(index, 1);
  if (tab.url && !tab.isStart) closedTabs = [...closedTabs, { url: tab.url, index }].slice(-20);
  if (tab.view) tab.view.remove();
  if (activeId === id) {
    const next = tabs[index] || tabs[tabs.length - 1];
    if (next) selectTab(next.id);
    else newTab();
  }
  renderTabs();
}

function navigateActive(url) {
  const tab = activeTab();
  if (!tab) return;
  tab.url = url;
  tab.isStart = false;
  tab.view.src = url;
  renderTabs();
}

// --- Pane controls + menu -------------------------------------------
$('back').addEventListener('click', () => { const v = activeTab()?.view; if (v && v.canGoBack()) v.goBack(); });
$('reload').addEventListener('click', () => { const t = activeTab(); if (t && !t.isStart) t.view.reload(); });
$('forward').addEventListener('click', () => { const v = activeTab()?.view; if (v && v.canGoForward()) v.goForward(); });
$('options').addEventListener('click', (e) => {
  e.stopPropagation();
  $('menu').classList.toggle('hidden');
});
document.addEventListener('click', () => $('menu').classList.add('hidden'));

async function refreshBlockerUI() {
  if (window.minimal) blocker = await window.minimal.getBlockerStatus();
  $('blocker-toggle').textContent =
    'Ad blocker: ' + (blocker.present ? (blocker.enabled ? 'On' : 'Off') : 'Unavailable');
  $('blocker-warning').classList.toggle('hidden', blocker.present);
  $('help-blocker').textContent = blocker.present ? (blocker.enabled ? 'On' : 'Off') : 'Unavailable';
}
$('blocker-toggle').addEventListener('click', async () => {
  if (window.minimal) blocker = await window.minimal.toggleBlocker();
  const view = activeTab()?.view;
  if (view && !activeTab().isStart) view.reload();
  refreshBlockerUI();
});

function doMenuAction(action) {
  $('menu').classList.add('hidden');
  if (action === 'new-tab') newTab();
  else if (action === 'new-window') window.open('index.html', '_blank');
  else if (action === 'close-tab') { const t = activeTab(); if (t) closeTab(t.id); }
  else if (action === 'go-to-url') showGoTo();
  else if (action === 'reload') { const v = activeTab()?.view; if (v) v.reload(); }
  else if (action === 'back') { const v = activeTab()?.view; if (v && v.canGoBack()) v.goBack(); }
  else if (action === 'forward') { const v = activeTab()?.view; if (v && v.canGoForward()) v.goForward(); }
  else if (action === 'toggle-ai') toggleAI();
  else if (action === 'reopen-tab') {
    // Back where it was in the list, as in Safari.
    const closed = closedTabs.pop();
    if (closed) {
      const tab = newTab(closed.url);
      tabs.splice(tabs.indexOf(tab), 1);
      tabs.splice(Math.min(closed.index, tabs.length), 0, tab);
      renderTabs();
    }
  }
  else if (action.startsWith('zoom-')) zoomActive(action.slice('zoom-'.length));
  else if (action === 'show-help') toggleHelp();
  else if (action.startsWith('select-tab-')) {
    // Ctrl/⌘+1…8 pick that tab; Ctrl/⌘+9 is always the last one, as in
    // Safari and Chrome. Caught in main.js whichever page has focus.
    const n = Number(action.slice('select-tab-'.length));
    const tab = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (tab) selectTab(tab.id);
  }
}
document.querySelectorAll('#menu [data-action]').forEach((btn) => {
  btn.addEventListener('click', () => doMenuAction(btn.dataset.action));
});
if (window.minimal) window.minimal.onMenuAction(doMenuAction);
if (window.minimal) window.minimal.onNavigateActive((url) => navigateActive(url));
if (window.minimal) {
  window.minimal.onOpenInNewTab((url, { background } = {}) => {
    newTab(url, { background });
    // A background tab gives no other sign it opened: peek the pane.
    if (background) peekPane();
  });
}

// --- Page zoom (View menu: ⌘0 / ⌘= / ⌘-) ----------------------------
// Chrome's zoom steps. Chromium keeps zoom per site, so every tab on
// the same site follows along, as in Chrome.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
function zoomActive(direction) {
  const tab = activeTab();
  if (!tab || tab.isStart || !tab.ready) return;
  const current = tab.view.getZoomFactor();
  let next = 1;
  if (direction === 'in') next = ZOOM_STEPS.find((z) => z > current + 0.001) ?? current;
  else if (direction === 'out') next = [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? current;
  tab.view.setZoomFactor(next);
}

// --- Help (Help menu → Net Help / Keyboard Shortcuts) -----------------
function toggleHelp(open = $('help').classList.contains('hidden')) {
  $('help').classList.toggle('hidden', !open);
}
$('help').addEventListener('click', (e) => { if (e.target === $('help')) toggleHelp(false); });
$('help-close').addEventListener('click', () => toggleHelp(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleHelp(false); });

// --- Go to URL + start page -----------------------------------------
// ⌘L opens it; ⌘L again, Esc, or clicking anywhere else closes it.
function hideGoTo() {
  if ($('goto').classList.contains('hidden')) return;
  $('goto').classList.add('hidden');
  const tab = activeTab();
  if (tab && !tab.isStart) tab.view.focus();
}
function showGoTo() {
  const pop = $('goto');
  if (!pop.classList.contains('hidden')) return hideGoTo();
  pop.classList.remove('hidden');
  const input = $('goto-input');
  input.value = '';
  input.focus();
}
$('goto-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = urlFor(e.target.value);
    hideGoTo();
    if (url) navigateActive(url);
  } else if (e.key === 'Escape') {
    hideGoTo();
  }
});
// Focus moving to a page or the pane closes it too. Deferred, so that
// ⌘L while it is open is a close, not a close-then-reopen.
$('goto-input').addEventListener('blur', () => setTimeout(hideGoTo, 0));
$('start-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = urlFor($('start-input').value);
  if (url) navigateActive(url);
});

// --- Settings (⋯ menu) -----------------------------------------------
// Kept in this page's localStorage, which lives in the app's persistent
// default session, so settings survive restarts.
const SETTINGS_KEY = 'net-browser.settings';
// glassTransparency: 0 = solid pane, 100 = clear glass (blur only).
// paneWidth: dragged with the pane's inner edge (see below).
const settings = { paneSide: 'right', panePinned: false, theme: 'system', glassTransparency: 66, paneWidth: 264, aiSide: 'left', aiAtLaunch: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY))); } catch {}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
function applySettings() {
  document.body.classList.toggle('pane-left', settings.paneSide === 'left');
  document.querySelectorAll('[data-side]').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.side === settings.paneSide);
  });
  document.querySelectorAll('[data-theme]').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.theme === settings.theme);
  });
  if (window.minimal) window.minimal.setTheme(settings.theme);
  $('pane-side-hint').textContent = settings.paneSide;
  $('pin-pane').textContent = 'Keep pane open: ' + (settings.panePinned ? 'On' : 'Off');
  applyGlass();
  applyPaneWidth();
  if (settings.panePinned) setPaneOpen(true);
  document.body.classList.toggle('ai-right', settings.aiSide === 'right');
  document.querySelectorAll('[data-ai-side]').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.aiSide === settings.aiSide);
  });
  $('ai-launch').textContent = 'Claude at launch: ' + (settings.aiAtLaunch ? 'On' : 'Off');
  syncWindowButtons();
}
document.querySelectorAll('[data-side]').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.paneSide = btn.dataset.side;
    saveSettings();
    applySettings();
  });
});
document.querySelectorAll('[data-theme]').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.theme = btn.dataset.theme;
    saveSettings();
    applySettings();
  });
  document.querySelectorAll('[data-ai-side]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.aiSide = btn.dataset.aiSide;
      saveSettings();
      applySettings();
    });
  });
  $('ai-launch').addEventListener('click', () => {
    settings.aiAtLaunch = !settings.aiAtLaunch;
    saveSettings();
    applySettings();
  });
});
// Transparency slider: drives --glass-opacity, which scales the pane's
// tint (styles.css). Applied live while dragging, saved on release.
function applyGlass() {
  $('glass-transparency').value = settings.glassTransparency;
  document.documentElement.style.setProperty('--glass-opacity', String(1 - settings.glassTransparency / 100));
}
$('glass-transparency').addEventListener('input', (e) => {
  settings.glassTransparency = Number(e.target.value);
  applyGlass();
});
$('glass-transparency').addEventListener('change', saveSettings);
// The slider sits in the ⋯ menu; a click on it must not close the menu.
$('glass-transparency').addEventListener('click', (e) => e.stopPropagation());
$('pin-pane').addEventListener('click', () => {
  settings.panePinned = !settings.panePinned;
  saveSettings();
  applySettings();
  if (!settings.panePinned) hideSidebarSoon();
});

// --- Tabs pane hover --------------------------------------------------
// The pane opens when the pointer touches its window edge and slides
// away again shortly after the pointer leaves it (unless pinned).
const PANE_WIDTH_DEFAULT = 264;
const PANE_WIDTH_MIN = 240; // narrower squeezes the nav capsule beside the traffic lights
const PANE_WIDTH_MAX = 560;
const PANE_INSET = 10; // keep in sync with --pane-inset
const PANE_EDGE = 24; // px from the window edge that opens the pane

function syncWindowButtons() {
  if (!window.minimal) return;
  const stage = $('stage').getBoundingClientRect();
  window.minimal.setWindowButtons($('sidebar').classList.contains('open'), settings.paneSide, settings.paneWidth, PANE_INSET,
    stage.left, window.innerWidth - stage.right);
}
function setPaneOpen(open) {
  const pane = $('sidebar');
  if (pane.classList.contains('open') === open) return;
  pane.classList.toggle('open', open);
  if (!open) $('menu').classList.add('hidden');
  syncWindowButtons();
}
function hideSidebarSoon() {
  if (settings.panePinned) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => setPaneOpen(false), 350);
}
function peekPane() {
  setPaneOpen(true);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!settings.panePinned) setPaneOpen(false); }, 1400);
}
// Pointer positions come from this page, and — over a loaded site,
// where the <webview> swallows mouse events — from main.js.
function onPointer(x) {
  const width = $('stage').clientWidth;
  if (x < 0 || x > width) { hideSidebarSoon(); return; }
  const fromEdge = settings.paneSide === 'left' ? x : width - x;
  // +6: the resize handle pokes a few px past the pane's inner edge.
  const inPane = $('sidebar').classList.contains('open') && fromEdge <= PANE_INSET + settings.paneWidth + 6;
  if (resizing) return;
  if (fromEdge <= PANE_EDGE || inPane) {
    clearTimeout(hideTimer);
    setPaneOpen(true);
  } else {
    hideSidebarSoon();
  }
}
document.addEventListener('mousemove', (e) => onPointer(e.clientX - $('stage').getBoundingClientRect().left));
// The right-side traffic lights are placed from the window's width.
window.addEventListener('resize', () => { applyPaneWidth(); syncWindowButtons(); });

// --- Expandable pane ---------------------------------------------------
// Drag the pane's inner edge to make it wider or narrower; double-click
// the edge to reset. While dragging, a shield covers the page: the
// pointer crosses the <webview>, which would otherwise swallow the
// mouse events and drop the drag.
let resizing = false;
function clampPaneWidth(width) {
  const max = Math.min(PANE_WIDTH_MAX, window.innerWidth - 2 * PANE_INSET - 160);
  return Math.round(Math.max(PANE_WIDTH_MIN, Math.min(max, width)));
}
function applyPaneWidth() {
  settings.paneWidth = clampPaneWidth(settings.paneWidth);
  document.documentElement.style.setProperty('--pane-width', settings.paneWidth + 'px');
}
$('pane-resize').addEventListener('mousedown', (e) => {
  e.preventDefault();
  resizing = true;
  clearTimeout(hideTimer);
  document.body.classList.add('resizing-pane');
});
document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const fromEdge = settings.paneSide === 'left' ? e.clientX : window.innerWidth - e.clientX;
  settings.paneWidth = clampPaneWidth(fromEdge - PANE_INSET);
  applyPaneWidth();
  syncWindowButtons();
});
document.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = false;
  document.body.classList.remove('resizing-pane');
  saveSettings();
});
$('pane-resize').addEventListener('dblclick', () => {
  settings.paneWidth = PANE_WIDTH_DEFAULT;
  applyPaneWidth();
  syncWindowButtons();
  saveSettings();
});
if (window.minimal) window.minimal.onGuestPointer(({ x }) => onPointer(x));

// --- Platform ----------------------------------------------------------
if (window.minimal && window.minimal.platform === 'linux') {
  document.body.classList.add('linux');
  // Start-page and help shortcuts say ⌘ on macOS; on Linux they are Ctrl.
  document.querySelectorAll('#start kbd, #help dt').forEach((kbd) => {
    kbd.textContent = kbd.textContent.replaceAll('⇧⌘', 'Ctrl+Shift+').replaceAll('⌘', 'Ctrl+').replaceAll('⌃', 'Ctrl+');
  });
}

if (window.minimal && window.minimal.platform === 'darwin') document.body.classList.add('mac');

// --- Claude pane -----------------------------------------------------------
const isMac = window.minimal?.platform === 'darwin';
const ai = { term: null, fit: null, exited: false };
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
const TERM_THEMES = {
  light: {
    background: '#00000000', foreground: '#1d1d1f', cursor: '#1d1d1f', cursorAccent: '#ffffff', selectionBackground: 'rgba(0, 122, 255, 0.22)',
    black: '#1d1d1f', red: '#c4314b', green: '#1f883d', yellow: '#9a6700', blue: '#0a62d0', magenta: '#8250df', cyan: '#1b7c83', white: '#6e6e73',
    brightBlack: '#86868b', brightRed: '#d1242f', brightGreen: '#2da44e', brightYellow: '#bf8700', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#3a3a3c',
    scrollbarSliderBackground: 'rgba(0, 0, 0, 0.16)', scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.28)', scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.38)',
  },
  dark: {
    background: '#00000000', foreground: '#f2f2f5', cursor: '#f2f2f5', cursorAccent: '#1c1c1e', selectionBackground: 'rgba(120, 170, 255, 0.30)',
    black: '#3a3a3c', red: '#ff6b6b', green: '#5fd38d', yellow: '#f2c94c', blue: '#5aa9ff', magenta: '#c792ea', cyan: '#5fd7d7', white: '#d1d1d6',
    brightBlack: '#8e8e93', brightRed: '#ff8787', brightGreen: '#7ee2a8', brightYellow: '#ffd866', brightBlue: '#82c0ff', brightMagenta: '#d6acff', brightCyan: '#8ae8e8', brightWhite: '#ffffff',
    scrollbarSliderBackground: 'rgba(255, 255, 255, 0.16)', scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.28)', scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.38)',
  },
};

function setAIOpen(open) {
  document.body.classList.toggle('ai-open', open);
  $('ai-toggle').textContent = open ? 'Hide Claude' : 'Show Claude';
  if (open) {
    startTerminal();
    setTimeout(() => { ai.fit?.fit(); ai.term?.focus(); }, 30);
  } else {
    ai.term?.blur();
  }
  syncWindowButtons();
}
function toggleAI() {
  setAIOpen(!document.body.classList.contains('ai-open'));
}

function startTerminal() {
  if (ai.term || !window.Terminal || !window.minimal) return;
  const term = new Terminal({
    allowTransparency: true,
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", Menlo, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    lineHeight: 1.12,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: TERM_THEMES[darkScheme.matches ? 'dark' : 'light'],
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => newTab(uri)));
  term.open($('term'));
  fit.fit();
  Object.assign(ai, { term, fit });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || isMac || !e.ctrlKey || !e.shiftKey || e.altKey) return true;
    if (e.code === 'KeyC') {
      e.preventDefault();
      if (term.hasSelection()) window.minimal.writeClipboard(term.getSelection());
      return false;
    }
    if (e.code === 'KeyV') {
      e.preventDefault();
      pasteIntoTerminal();
      return false;
    }
    return true;
  });
  $('term').addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const choice = await window.minimal.termMenu(term.hasSelection());
    if (choice === 'copy') window.minimal.writeClipboard(term.getSelection());
    else if (choice === 'paste') pasteIntoTerminal();
    else if (choice === 'clear') term.clear();
    term.focus();
  });

  term.onData((data) => {
    if (ai.exited) restartTerminal();
    else window.minimal.termInput(data);
  });
  term.onResize(({ cols, rows }) => window.minimal.termResize(cols, rows));
  term.textarea.addEventListener('focus', () => window.minimal.termFocus(true));
  term.textarea.addEventListener('blur', () => window.minimal.termFocus(false));
  window.minimal.onTermData((data) => term.write(data));
  window.minimal.onTermExit(() => {
    ai.exited = true;
    term.write('\r\n\x1b[2m[Session ended. Press any key, or ↻ above, to start Claude again.]\x1b[0m\r\n');
  });
  new ResizeObserver(() => {
    if (document.body.classList.contains('ai-open')) fit.fit();
  }).observe($('term'));
  darkScheme.addEventListener('change', () => {
    term.options.theme = TERM_THEMES[darkScheme.matches ? 'dark' : 'light'];
  });
  startSession(false);
}

function startSession(restart) {
  window.minimal.termStart(ai.term.cols, ai.term.rows, restart).catch((err) => {
    ai.exited = true;
    ai.term.write(`\r\n\x1b[31m${String(err.message).replace(/^Error invoking remote method 'term-start': (Error: )?/, '')}\x1b[0m\r\n`);
  });
}

async function pasteIntoTerminal() {
  const text = await window.minimal.readClipboard();
  if (text) ai.term.paste(text);
}

function restartTerminal() {
  if (!ai.term) return startTerminal();
  ai.exited = false;
  ai.term.reset();
  startSession(true);
  ai.term.focus();
}

$('ai-restart').addEventListener('click', () => restartTerminal());
$('ai-hide').addEventListener('click', () => setAIOpen(false));
window.minimal?.onAIFocusTerminal(() => {
  if (document.body.classList.contains('ai-open')) ai.term?.focus();
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ai-pane')) window.minimal?.termLeave();
});

// --- Claude's cursor --------------------------------------------------------
const cursorEl = $('ai-cursor');
const cursorTimers = { note: null, box: null, idle: null };

function moveAICursor({ x, y, duration = 300, note = '', box = null, click = false }) {
  if (click) {
    cursorEl.classList.remove('clicking');
    void cursorEl.offsetWidth;
    cursorEl.classList.add('clicking');
    return;
  }
  if (cursorEl.classList.contains('hidden')) {
    cursorEl.style.transitionDuration = '0ms';
    cursorEl.style.transform = `translate(${x - 120}px, ${y + 80}px)`;
    cursorEl.style.opacity = '0';
    cursorEl.classList.remove('hidden');
    void cursorEl.offsetWidth;
    cursorEl.style.opacity = '';
  }
  const stage = $('stage');
  cursorEl.classList.remove('idle');
  cursorEl.style.transitionDuration = `${duration}ms, 0.3s`;
  cursorEl.style.transform = `translate(${x}px, ${y}px)`;
  cursorEl.classList.toggle('flip-x', x > stage.clientWidth - 290);
  cursorEl.classList.toggle('flip-y', y > stage.clientHeight - 150);

  const noteEl = $('ai-note');
  clearTimeout(cursorTimers.note);
  noteEl.textContent = note;
  noteEl.classList.toggle('hidden', !note);
  if (note) cursorTimers.note = setTimeout(() => noteEl.classList.add('hidden'), 12000);

  const boxEl = $('ai-box');
  clearTimeout(cursorTimers.box);
  boxEl.classList.add('hidden');
  if (box) {
    cursorTimers.box = setTimeout(() => {
      Object.assign(boxEl.style, { left: `${box.left - 4}px`, top: `${box.top - 4}px`, width: `${box.width + 8}px`, height: `${box.height + 8}px` });
      boxEl.classList.remove('hidden');
      cursorTimers.box = setTimeout(() => boxEl.classList.add('hidden'), 8000);
    }, duration * 0.7);
  }
  clearTimeout(cursorTimers.idle);
  cursorTimers.idle = setTimeout(() => cursorEl.classList.add('idle'), 10000);
}
window.minimal?.onAICursor(moveAICursor);

window.netAI = {
  state: () => ({
    tabs: tabs.map((tab, i) => ({
      index: i + 1,
      title: tab.title,
      url: tab.url,
      isStart: !!tab.isStart,
      active: tab.id === activeId,
      webContentsId: tab.ready && !tab.isStart ? tab.view.getWebContentsId() : null,
    })),
  }),
  navigate: (url) => { navigateActive(url); return true; },
  open: (url) => { newTab(url); return true; },
  select: (n) => {
    const tab = tabs[n - 1];
    if (!tab) return false;
    selectTab(tab.id);
    return true;
  },
};

// --- Boot ------------------------------------------------------------
applySettings();
newTab();
refreshBlockerUI();
if (settings.aiAtLaunch && new URLSearchParams(location.search).has('launch')) setAIOpen(true);
