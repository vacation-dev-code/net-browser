// Minimal v0.1 — UI process: tabs, tabs pane, shortcuts, and the
// Claude pane (terminal + Claude's cursor; see main.js → ai/).
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
//   moving tab creation there) — except Claude's cursor, which also
//   overlays the page, and would need an overlay view of its own.
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

let tabs = []; // { id, title, url, view, isStart, ready }
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
    const letter = (tab.title || 'New Tab').trim().charAt(0).toUpperCase() || '·';
    row.innerHTML = '';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = letter;
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
    renderTabs();
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
    setTimeout(() => $('start-input').focus(), 0);
  }
  clearAIMarks(); // Claude's note and highlight belonged to the other tab
  hideSidebarSoon();
  renderTabs();
}

function closeTab(id) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;
  const [tab] = tabs.splice(index, 1);
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
  $('blocker-note').textContent = blocker.present
    ? 'Ad blocking: uBlock Origin / EasyList filters via the Ghostery engine, running in the background. On/off is in the ⋯ menu at the bottom of the tabs pane.'
    : 'Ad blocking is OFF — the filter lists could not be loaded. See the warning above.';
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
  else if (action.startsWith('select-tab-')) {
    // Ctrl/⌘+1…9, caught in main.js whichever page has focus.
    const tab = tabs[Number(action.slice('select-tab-'.length)) - 1];
    if (tab) selectTab(tab.id);
  }
}
document.querySelectorAll('#menu [data-action]').forEach((btn) => {
  btn.addEventListener('click', () => doMenuAction(btn.dataset.action));
});
if (window.minimal) window.minimal.onMenuAction(doMenuAction);
if (window.minimal) {
  window.minimal.onOpenInNewTab((url, { background } = {}) => {
    newTab(url, { background });
    // A background tab gives no other sign it opened: peek the pane.
    if (background) peekPane();
  });
}

// --- Go to URL + start page -----------------------------------------
function showGoTo() {
  const pop = $('goto');
  pop.classList.remove('hidden');
  const input = $('goto-input');
  input.value = '';
  input.focus();
}
$('goto-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = urlFor(e.target.value);
    $('goto').classList.add('hidden');
    if (url) navigateActive(url);
  } else if (e.key === 'Escape') {
    $('goto').classList.add('hidden');
  }
});
$('start-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = urlFor($('start-input').value);
  if (url) navigateActive(url);
});

// --- Settings (⋯ menu) -----------------------------------------------
// Kept in this page's localStorage, which lives in the app's persistent
// default session, so settings survive restarts.
const SETTINGS_KEY = 'net-browser.settings';
const settings = { paneSide: 'right', panePinned: false, theme: 'system', aiSide: 'left', aiAtLaunch: true };
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
$('pin-pane').addEventListener('click', () => {
  settings.panePinned = !settings.panePinned;
  saveSettings();
  applySettings();
  if (!settings.panePinned) hideSidebarSoon();
});

// --- Tabs pane hover --------------------------------------------------
// The pane opens when the pointer touches its window edge and slides
// away again shortly after the pointer leaves it (unless pinned).
const PANE_WIDTH = 264; // keep in sync with --pane-width / --pane-inset
const PANE_INSET = 10;
const PANE_EDGE = 24; // px from the window edge that opens the pane

function syncWindowButtons() {
  if (!window.minimal) return;
  const stage = $('stage').getBoundingClientRect();
  window.minimal.setWindowButtons($('sidebar').classList.contains('open'), settings.paneSide, PANE_WIDTH, PANE_INSET,
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
// where the <webview> swallows mouse events — from main.js. Both are
// page-area x: the pane opens at the edge of the page area, which is
// the window edge unless the Claude pane is on that side.
function onPointer(x) {
  const width = $('stage').clientWidth;
  if (x < 0 || x > width) { hideSidebarSoon(); return; } // over the Claude pane
  const fromEdge = settings.paneSide === 'left' ? x : width - x;
  const inPane = $('sidebar').classList.contains('open') && fromEdge <= PANE_INSET + PANE_WIDTH;
  if (fromEdge <= PANE_EDGE || inPane) {
    clearTimeout(hideTimer);
    setPaneOpen(true);
  } else {
    hideSidebarSoon();
  }
}
document.addEventListener('mousemove', (e) => onPointer(e.clientX - $('stage').getBoundingClientRect().left));
if (window.minimal) window.minimal.onGuestPointer(({ x }) => onPointer(x));

// --- Platform ----------------------------------------------------------
if (window.minimal && window.minimal.platform === 'linux') {
  document.body.classList.add('linux');
  // Start-page hints say ⌘ on macOS; on Linux they are Ctrl.
  document.querySelectorAll('#start kbd').forEach((kbd) => {
    kbd.textContent = kbd.textContent.replace(/⌘|⌃/, 'Ctrl+');
  });
}

if (window.minimal && window.minimal.platform === 'darwin') document.body.classList.add('mac');

// --- Claude pane -----------------------------------------------------------
// A terminal running Claude Code (main.js → ai/terminal.js), drawn with
// xterm.js. It starts the first time the pane opens and keeps running
// while the pane is hidden, so hiding it does not end the conversation.
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
  // Links Claude prints open as tabs, right beside it.
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => newTab(uri)));
  term.open($('term'));
  fit.fit();
  Object.assign(ai, { term, fit });

  // Linux terminals copy and paste with Ctrl+Shift+C / V (plain Ctrl+C
  // is interrupt). macOS ⌘C / ⌘V come through the Edit menu (main.js).
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
    e.preventDefault(); // instead of main.js's page menu
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
// After Claude acts on a page, the keyboard goes back to the terminal if
// that is where the user was working (ai/terminal.js). A click anywhere
// else in this page means they moved on.
window.minimal?.onAIFocusTerminal(() => {
  if (document.body.classList.contains('ai-open')) ai.term?.focus();
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ai-pane')) window.minimal?.termLeave();
});

// --- Claude's cursor --------------------------------------------------------
// main.js (ai/browser-tools.js) sends where to go in page-area pixels.
// The tab fills the page area, so tab coordinates need no conversion.
const cursorEl = $('ai-cursor');
const cursorTimers = { note: null, box: null, idle: null };

function moveAICursor({ x, y, duration = 300, note = '', box = null, click = false }) {
  if (click) {
    cursorEl.classList.remove('clicking');
    void cursorEl.offsetWidth; // restart the ripple animation
    cursorEl.classList.add('clicking');
    return;
  }
  if (cursorEl.classList.contains('hidden')) {
    // First appearance: fade in a little below-left, then glide over.
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

  // The highlight ring lands as the cursor arrives, not before it.
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
function clearAIMarks() {
  clearTimeout(cursorTimers.box);
  $('ai-note').classList.add('hidden');
  $('ai-box').classList.add('hidden');
}
window.minimal?.onAICursor(moveAICursor);

// --- For Claude's browser tools ----------------------------------------------
// main.js (ai/browser-tools.js) reads and drives the tab list through
// this, with executeJavaScript on this page. Web pages cannot reach it:
// they run in <webview> guests, a different page entirely.
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
// Windows opened at startup carry ?launch=1 (main.js createWindow).
if (settings.aiAtLaunch && new URLSearchParams(location.search).has('launch')) setAIOpen(true);
