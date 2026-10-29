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
const settings = { paneSide: 'right', panePinned: false, theme: 'system' };
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
  if (window.minimal) {
    window.minimal.setWindowButtons($('sidebar').classList.contains('open'), settings.paneSide, PANE_WIDTH, PANE_INSET);
  }
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
  const fromEdge = settings.paneSide === 'left' ? x : window.innerWidth - x;
  const inPane = $('sidebar').classList.contains('open') && fromEdge <= PANE_INSET + PANE_WIDTH;
  if (fromEdge <= PANE_EDGE || inPane) {
    clearTimeout(hideTimer);
    setPaneOpen(true);
  } else {
    hideSidebarSoon();
  }
}
document.addEventListener('mousemove', (e) => onPointer(e.clientX));
if (window.minimal) window.minimal.onGuestPointer(({ x }) => onPointer(x));

// --- Platform ----------------------------------------------------------
if (window.minimal && window.minimal.platform === 'linux') {
  document.body.classList.add('linux');
  // Start-page hints say ⌘ on macOS; on Linux they are Ctrl.
  document.querySelectorAll('#start kbd').forEach((kbd) => {
    kbd.textContent = kbd.textContent.replace('⌘', 'Ctrl+');
  });
}

if (window.minimal && window.minimal.platform === 'darwin') document.body.classList.add('mac');

// --- Boot ------------------------------------------------------------
applySettings();
newTab();
refreshBlockerUI();
