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
const settings = { paneSide: 'right', panePinned: false, theme: 'system', glassTransparency: 66, paneWidth: 264 };
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
  if (window.minimal) {
    window.minimal.setWindowButtons($('sidebar').classList.contains('open'), settings.paneSide, settings.paneWidth, PANE_INSET);
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
document.addEventListener('mousemove', (e) => onPointer(e.clientX));
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
    kbd.textContent = kbd.textContent.replaceAll('⇧⌘', 'Ctrl+Shift+').replaceAll('⌘', 'Ctrl+');
  });
}

if (window.minimal && window.minimal.platform === 'darwin') document.body.classList.add('mac');

// --- Boot ------------------------------------------------------------
applySettings();
newTab();
refreshBlockerUI();
