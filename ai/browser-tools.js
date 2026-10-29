// Claude's eyes and hands in Net Browser: an MCP server that Claude Code,
// running in the Claude pane (ai/terminal.js), uses to read, point at and
// operate the active tab of its own window — with its own visible cursor,
// which renderer/renderer.js draws over the page.
//
// Transport, and why not a localhost port: every web page the browser
// opens can send requests to 127.0.0.1, and a page that reached these
// tools could drive the browser. So the server listens on a Unix socket
// in userData (mode 0600) that pages cannot reach, and a connection must
// open with this launch's random token. Claude Code speaks MCP over
// stdio, so it runs ai/mcp-bridge.js, which pipes stdio to the socket.
//
// The tools only touch <webview> tabs, never the UI page, and their
// page-side code runs in an isolated world, so pages can neither see
// nor tamper with it. Page content is untrusted input to Claude: the
// prompt in ai/terminal.js tells it never to follow instructions found
// in a page, and the tools that act (click, type, keys, navigate) go
// through Claude Code's permission prompt.

const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow, webContents } = require('electron');
const { returnsToTerminal } = require('./terminal');

const WORLD = 1077; // isolated world for page-side code (Electron's preload world is 999)
const TOKEN = crypto.randomBytes(24).toString('hex');
const BRIDGE = path.join(__dirname, 'mcp-bridge.js');
const VERSION = require('../package.json').version;

let server = null;
let socketPath = null;
const sessions = new Map(); // window id -> { windowId, queue, cursor, shot }
const synthetic = new Map(); // guest webContents id -> until when its mouse input is Claude's
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Server -------------------------------------------------------------
// Socket paths are capped at 104 bytes on macOS (108 on Linux). A long
// home folder can push userData past that, so fall back to a private
// folder in the temp dir — made 0700 and checked to be ours, since /tmp
// is shared and someone else could have planted the name first.
function socketDir(userData) {
  if (Buffer.byteLength(path.join(userData, 'ai-0000000.sock')) <= 100) return userData;
  const dir = path.join(os.tmpdir(), `net-browser-${process.getuid()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error(`${dir} is not a private folder of this user.`);
  return dir;
}

async function start(userData) {
  fs.mkdirSync(userData, { recursive: true });
  const dir = socketDir(userData);
  // Sockets left by crashed launches: remove those whose process is gone.
  for (const name of fs.readdirSync(dir)) {
    const pid = /^ai-(\d+)\.sock$/.exec(name)?.[1];
    if (!pid) continue;
    try { process.kill(Number(pid), 0); } catch (err) { if (err.code === 'ESRCH') fs.rmSync(path.join(dir, name), { force: true }); }
  }
  socketPath = path.join(dir, `ai-${process.pid}.sock`);
  fs.rmSync(socketPath, { force: true });
  server = net.createServer(onConnection);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
}

function stop() {
  server?.close();
  if (socketPath) fs.rmSync(socketPath, { force: true });
}

// How Claude Code starts the bridge for one window (see ai/terminal.js).
// Electron's own binary runs it as plain Node, so no Node.js install is
// needed; a packaged build must keep the RunAsNode fuse on for this.
function mcpConfig(win) {
  if (!socketPath) return { mcpServers: {} };
  return {
    mcpServers: {
      'net-browser': {
        type: 'stdio',
        command: process.execPath,
        args: [BRIDGE],
        env: { ELECTRON_RUN_AS_NODE: '1', NET_BROWSER_SOCKET: socketPath, NET_BROWSER_TOKEN: TOKEN, NET_BROWSER_WINDOW: String(win.id) },
      },
    },
  };
}

// main.js skips forwarding Claude's own mouse events to the tabs pane's
// hover logic, so a click near the window edge does not pop the pane.
function isSynthetic(guestId) {
  return (synthetic.get(guestId) || 0) > Date.now();
}

function validToken(token) {
  const a = Buffer.from(String(token));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Newline-delimited JSON-RPC, as MCP's stdio transport is. The first line
// is the bridge's {token, window}; anything else first closes the socket.
function onConnection(sock) {
  let buffer = '';
  let session = null;
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) !== -1;) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!session) {
        if (!validToken(msg.token) || !BrowserWindow.fromId(Number(msg.window))) { sock.destroy(); return; }
        session = sessionFor(Number(msg.window));
        continue;
      }
      handle(session, msg).then((reply) => {
        if (reply && !sock.destroyed) sock.write(JSON.stringify(reply) + '\n');
      });
    }
  });
}

function sessionFor(windowId) {
  if (!sessions.has(windowId)) sessions.set(windowId, { windowId, queue: Promise.resolve(), cursor: null, shot: null });
  return sessions.get(windowId);
}

const INSTRUCTIONS = 'Tools for the Net Browser window this terminal is in. They act on its active tab. '
  + 'read_page lists the page\'s elements as [ref] numbers; screenshot shows it. point moves your visible '
  + 'cursor to an element with an optional note, without clicking: use it to show the user where to look.';

async function handle(session, { id, method, params }) {
  if (id === undefined || id === null) return null; // notifications need no reply
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'net-browser', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ run, ...spec }) => spec) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      // One action at a time per window: Claude may call tools in
      // parallel, but there is one cursor and one page.
      const run = session.queue.then(() => tool.run(session, params.arguments || {}));
      session.queue = run.catch(() => {});
      try {
        const out = await run;
        return reply(typeof out === 'string' ? text(out) : out);
      } catch (err) {
        return reply({ ...text(err.message), isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

// --- Window and tab --------------------------------------------------------
// The UI page owns the tab list; renderer.js exposes it as window.netAI.
async function context(session) {
  const win = BrowserWindow.fromId(session.windowId);
  if (!win || win.isDestroyed()) throw new Error('This Net Browser window has been closed.');
  const state = await win.webContents.executeJavaScript('netAI.state()');
  const tab = state.tabs.find((t) => t.active) || null;
  const guest = tab?.webContentsId ? webContents.fromId(tab.webContentsId) : null;
  return { win, state, tab, guest: guest && !guest.isDestroyed() ? guest : null };
}

function needPage(ctx) {
  if (!ctx.guest) throw new Error('The active tab is a blank new-tab page. Open a site first with navigate.');
  return ctx.guest;
}

// Wait for a click or navigation to land, up to a limit: some sites
// never stop loading.
async function settle(session, timeout = 8000) {
  const started = Date.now();
  await sleep(350);
  for (;;) {
    const ctx = await context(session);
    if (ctx.guest && !ctx.guest.isLoading()) return ctx;
    if (!ctx.guest && !ctx.tab?.url) return ctx;
    if (Date.now() - started > timeout) return ctx;
    await sleep(200);
  }
}

const where = (ctx) => (ctx.guest ? `Now on: ${ctx.guest.getTitle()} — ${ctx.guest.getURL()}` : 'Now on: a new-tab page');

function webURL(input) {
  let s = String(input || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  const url = new URL(s);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('navigate only opens http(s) web addresses.');
  return url.href;
}

// --- Page side (run in the isolated world) -------------------------------
function inPage(guest, fn, ...args) {
  return guest.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${fn})(...${JSON.stringify(args)})` }]);
}

// Numbers what a person could act on or be shown — controls, links,
// fields, headings, labelled images — and keeps the numbering in this
// world, invisible to the page, until the next read. Password values
// never leave the page.
function snapshotPage(fullText) {
  const SELECTOR = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [contenteditable=""], [contenteditable=true], '
    + '[role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [role=textbox], '
    + 'h1, h2, h3, img[alt]:not([alt=""])';
  const refs = (globalThis.__netRefs = new Map());
  const vw = innerWidth;
  const vh = innerHeight;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const roleOf = (el) => {
    const tag = el.tagName;
    if (el.getAttribute('role')) return el.getAttribute('role');
    if (/^H[1-3]$/.test(tag)) return 'heading ' + tag[1];
    if (tag === 'INPUT') return ['checkbox', 'radio', 'submit', 'button', 'range', 'file', 'reset'].includes(el.type) ? el.type : 'textbox';
    return { A: 'link', BUTTON: 'button', SELECT: 'select', TEXTAREA: 'textbox', SUMMARY: 'button', IMG: 'image' }[tag] || (el.isContentEditable ? 'textbox' : tag.toLowerCase());
  };
  const nameOf = (el) => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText)
    || el.innerText || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || '').slice(0, 80);
  const stateOf = (el) => {
    let s = '';
    if (el.tagName === 'INPUT' && el.type === 'password') s += ' (password field)';
    else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) s += el.checked ? ' (checked)' : ' (unchecked)';
    else if (el.tagName === 'SELECT') s += ` selected="${clean(el.selectedOptions[0] && el.selectedOptions[0].text).slice(0, 60)}"`;
    else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') s += ` value="${clean(el.value).slice(0, 60)}"`;
    if (el.disabled) s += ' (disabled)';
    return s;
  };
  const inView = [];
  const below = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    const visible = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    if (visible && inView.length < 150) inView.push(el);
    else if (!visible && r.top >= vh && below.length < 40) below.push(el);
  }
  let n = 0;
  const line = (el) => {
    const ref = ++n;
    const desc = `${roleOf(el)} "${nameOf(el)}"`;
    refs.set(ref, { el, desc: `[${ref}] ${desc}` });
    return `[${ref}] ${desc}${stateOf(el)}`;
  };
  // Text: what is on screen, or with fullText the whole page, capped.
  const limit = fullText ? 15000 : 3500;
  const parts = [];
  let length = 0;
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && length < limit; node = walker.nextNode()) {
    const t = clean(node.nodeValue);
    const parent = node.parentElement;
    if (!t || !parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!fullText && (r.bottom < 0 || r.top > vh)) continue;
    parts.push(t);
    length += t.length + 1;
  }
  const height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  return [
    `Title: ${document.title}`,
    `URL: ${location.href}`,
    `Viewport ${vw}×${vh}, scrolled to ${Math.round(scrollY)} of ${height} px`,
    '',
    'On screen ([ref] role "name"):',
    ...(inView.length ? inView.map(line) : ['(nothing interactive)']),
    ...(below.length ? ['', 'Further down:', ...below.map(line)] : []),
    '',
    fullText ? 'Page text:' : 'Text on screen:',
    parts.join(' ').slice(0, limit) || '(none)',
  ].join('\n');
}

// Where element [ref] is, in viewport px. Off screen, it is first
// scrolled into view (smoothly, so the user can follow) and measured
// on a second call.
function measureRef(ref, scroll) {
  const entry = globalThis.__netRefs && globalThis.__netRefs.get(ref);
  if (!entry || !entry.el.isConnected) return null;
  const r = entry.el.getBoundingClientRect();
  const onScreen = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  if (!onScreen && scroll) {
    entry.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    return { scrolling: true };
  }
  return {
    onScreen,
    x: Math.min(Math.max(r.left + r.width / 2, 2), innerWidth - 2),
    y: Math.min(Math.max(r.top + r.height / 2, 2), innerHeight - 2),
    box: { left: r.left, top: r.top, width: r.width, height: r.height },
    label: entry.desc,
  };
}

function pageMetrics() {
  return { w: innerWidth, h: innerHeight, y: Math.round(scrollY) };
}

function focusedIsEditable() {
  const a = document.activeElement;
  return !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(a.type)));
}

// --- Cursor and input --------------------------------------------------------
async function resolveTarget(session, ctx, args) {
  const guest = needPage(ctx);
  if (args.ref !== undefined && args.ref !== null) {
    let m = await inPage(guest, measureRef, Number(args.ref), true);
    if (m && m.scrolling) {
      // Smooth scrolling takes longer the further it goes: measure until
      // the element stops moving, or a click lands where it used to be.
      // (Compare the real box: x/y are clamped to the screen, so an
      // element still off screen would look like it had stopped.)
      let last = null;
      for (let i = 0; i < 30; i++) {
        await sleep(80);
        m = await inPage(guest, measureRef, Number(args.ref), false);
        if (!m || (m.onScreen && last && m.box.top === last.box.top && m.box.left === last.box.left)) break;
        last = m;
      }
    }
    if (!m) throw new Error(`There is no element [${args.ref}] on this page any more. Call read_page again for fresh numbers.`);
    return m;
  }
  if (args.x !== undefined && args.y !== undefined) {
    // x/y come from the latest screenshot, which may be scaled down.
    const scale = session.shot && session.shot.guestId === guest.id ? session.shot.scale : 1;
    return { x: Number(args.x) * scale, y: Number(args.y) * scale, label: `the point (${args.x}, ${args.y})` };
  }
  throw new Error('Give either ref (a number from read_page) or x and y (pixels in the latest screenshot).');
}

// The cursor glides at a speed a person can follow, and the tool waits
// for it to arrive. Coordinates are tab-relative, which renderer.js
// draws as they are: the tab fills the page area.
async function moveCursor(session, ctx, target, { note = '', box = null } = {}) {
  const zoom = ctx.guest.getZoomFactor();
  const x = target.x * zoom;
  const y = target.y * zoom;
  const from = session.cursor || { x: x - 120, y: y + 80 };
  const duration = Math.round(Math.min(900, Math.max(280, Math.hypot(x - from.x, y - from.y) * 0.9)));
  session.cursor = { x, y };
  const scaled = box && { left: box.left * zoom, top: box.top * zoom, width: box.width * zoom, height: box.height * zoom };
  ctx.win.webContents.send('ai-cursor', { x, y, duration, note: String(note || '').slice(0, 280), box: scaled });
  await sleep(duration + 90);
}

function clickAt(ctx, target) {
  const guest = ctx.guest;
  const zoom = guest.getZoomFactor();
  const x = Math.round(target.x * zoom);
  const y = Math.round(target.y * zoom);
  synthetic.set(guest.id, Date.now() + 500);
  guest.sendInputEvent({ type: 'mouseMove', x, y });
  guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  ctx.win.webContents.send('ai-cursor', { click: true });
}

const KEYS = {
  enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  space: 'Space', ' ': 'Space', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};
const MODIFIERS = { ctrl: 'control', control: 'control', shift: 'shift', alt: 'alt', option: 'alt', meta: 'meta', cmd: 'meta', command: 'meta' };

function sendKey(guest, key, modifierNames = []) {
  const keyCode = KEYS[String(key).toLowerCase()] || (String(key).length === 1 ? String(key) : null);
  if (!keyCode) throw new Error(`Unknown key "${key}". Use one character, or Enter, Escape, Tab, Backspace, Delete, Space, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End.`);
  const modifiers = modifierNames.map((m) => MODIFIERS[String(m).toLowerCase()]).filter(Boolean);
  guest.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // Text keys also need a char event, or fields and forms never see them.
  const char = keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : keyCode.length === 1 ? keyCode : null;
  if (char && !modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt')) guest.sendInputEvent({ type: 'char', keyCode: char, modifiers });
  guest.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

// Claude's clicks and keys move the keyboard into the page (keys only
// reach a focused page). If the user was working in the terminal, hand
// it back afterwards, so they can keep typing to Claude.
function giveBackKeyboard(ctx) {
  if (returnsToTerminal(ctx.win.id) && !ctx.win.isDestroyed()) ctx.win.webContents.send('ai-focus-terminal');
}

async function withPageFocus(ctx, fn) {
  ctx.guest.focus();
  try {
    return await fn();
  } finally {
    giveBackKeyboard(ctx);
  }
}

// --- Tools -------------------------------------------------------------------
const target = {
  ref: { type: 'integer', description: 'Element number from the latest read_page.' },
  x: { type: 'number', description: 'Horizontal pixel in the latest screenshot (use with y, instead of ref).' },
  y: { type: 'number', description: 'Vertical pixel in the latest screenshot.' },
};

const TOOLS = [
  {
    name: 'read_page',
    description: 'Read the active tab: title, URL, scroll position, the elements on screen numbered as [ref] (links, buttons, fields, headings), elements further down, and the text on screen. Cheap: call it first, and again after the page changes. Main frame only, not inside iframes.',
    inputSchema: { type: 'object', properties: { full_text: { type: 'boolean', description: 'Include the whole page\'s text, not just what is on screen.' } } },
    annotations: { readOnlyHint: true },
    async run(session, { full_text }) {
      const ctx = await context(session);
      const guest = needPage(ctx);
      const header = `Tab ${ctx.tab.index} of ${ctx.state.tabs.length}.`;
      return `${header}\n${await inPage(guest, snapshotPage, !!full_text)}`;
    },
  },
  {
    name: 'screenshot',
    description: 'See the visible part of the active tab as an image. Use it when layout, images or visual state matter. x/y for point and click are pixels in this image.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run(session) {
      const ctx = await context(session);
      const guest = needPage(ctx);
      const m = await inPage(guest, pageMetrics);
      const image = await guest.capturePage();
      if (image.isEmpty()) throw new Error('Could not capture the tab. Is the window minimised?');
      const width = Math.min(m.w, 1280);
      const shot = image.resize({ width, quality: 'good' });
      session.shot = { guestId: guest.id, scale: m.w / width };
      return {
        content: [
          { type: 'image', data: shot.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' },
          { type: 'text', text: `Visible part of the tab, ${width}×${shot.getSize().height} px. For point or click here, pass x and y in these pixels.` },
        ],
      };
    },
  },
  {
    name: 'point',
    description: 'Move your visible cursor to an element, highlight it, and optionally show a short note beside it, WITHOUT clicking. This is how you show the user where to look or what to click when teaching.',
    inputSchema: { type: 'object', properties: { ...target, note: { type: 'string', description: 'A short caption beside your cursor, e.g. "Click here to open Settings".' } } },
    annotations: { readOnlyHint: true },
    async run(session, args) {
      const ctx = await context(session);
      const t = await resolveTarget(session, ctx, args);
      await moveCursor(session, ctx, t, { note: args.note, box: t.box });
      return `Pointing at ${t.label}${args.note ? `, with the note "${args.note}"` : ''}. The user sees your cursor there.`;
    },
  },
  {
    name: 'click',
    description: 'Move your cursor to an element and click it, then wait for the page to settle.',
    inputSchema: { type: 'object', properties: { ...target, note: { type: 'string', description: 'Optional caption shown while clicking.' } } },
    async run(session, args) {
      let ctx = await context(session);
      const t = await resolveTarget(session, ctx, args);
      await moveCursor(session, ctx, t, { note: args.note, box: t.box });
      clickAt(ctx, t);
      giveBackKeyboard(ctx);
      ctx = await settle(session);
      return `Clicked ${t.label}. ${where(ctx)}`;
    },
  },
  {
    name: 'type',
    description: 'Type text into a field. With ref, clicks the field first; without it, types into the field that has focus. Replaces what the field holds unless replace is false.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ref: target.ref,
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
        replace: { type: 'boolean', description: 'Replace the field\'s current text (default true).' },
      },
      required: ['text'],
    },
    async run(session, { text: value, ref, submit = false, replace = true }) {
      let ctx = await context(session);
      const guest = needPage(ctx);
      let label = 'the focused field';
      if (ref !== undefined && ref !== null) {
        const t = await resolveTarget(session, ctx, { ref });
        await moveCursor(session, ctx, t, { box: t.box });
        clickAt(ctx, t);
        label = t.label;
        await sleep(120);
      }
      await withPageFocus(ctx, async () => {
        if (!(await inPage(guest, focusedIsEditable))) throw new Error('No text field has focus. Pass the field\'s ref.');
        if (replace) sendKey(guest, 'a', [process.platform === 'darwin' ? 'meta' : 'control']);
        await guest.insertText(String(value));
        if (submit) sendKey(guest, 'Enter');
      });
      if (submit) ctx = await settle(session);
      return `Typed ${JSON.stringify(String(value).slice(0, 80))} into ${label}${submit ? ` and pressed Enter. ${where(ctx)}` : '.'}`;
    },
  },
  {
    name: 'press_key',
    description: 'Press a key in the active tab, e.g. Enter, Escape, Tab, ArrowDown, PageDown, or a character with modifiers.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'meta'] } },
      },
      required: ['key'],
    },
    async run(session, { key, modifiers = [] }) {
      let ctx = await context(session);
      const guest = needPage(ctx);
      await withPageFocus(ctx, () => sendKey(guest, key, modifiers));
      ctx = await settle(session, 3000);
      return `Pressed ${[...modifiers, key].join('+')}. ${where(ctx)}`;
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the active tab up or down by screens (default 0.8), or bring element [ref] into view.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        screens: { type: 'number', description: 'How far, in screen heights (default 0.8).' },
        ref: target.ref,
      },
    },
    annotations: { readOnlyHint: true },
    async run(session, { direction = 'down', screens = 0.8, ref }) {
      const ctx = await context(session);
      const guest = needPage(ctx);
      if (ref !== undefined && ref !== null) {
        const t = await resolveTarget(session, ctx, { ref });
        return `Scrolled ${t.label} into view.`;
      }
      // A wheel turn under the cursor (or mid-page) scrolls whatever is
      // there, the way a person's would — including inner scroll areas.
      const m = await inPage(guest, pageMetrics);
      const zoom = guest.getZoomFactor();
      const at = session.cursor || { x: (m.w * zoom) / 2, y: (m.h * zoom) / 2 };
      const delta = Math.round(m.h * zoom * Math.min(Math.max(Number(screens) || 0.8, 0.1), 5));
      synthetic.set(guest.id, Date.now() + 500);
      guest.sendInputEvent({ type: 'mouseWheel', x: Math.round(at.x), y: Math.round(at.y), deltaX: 0, deltaY: direction === 'up' ? delta : -delta, canScroll: true });
      await sleep(450);
      const after = await inPage(guest, pageMetrics);
      return after.y === m.y
        ? `Nothing scrolled (already at the ${direction === 'up' ? 'top' : 'bottom'}, or the area under the cursor does not scroll).`
        : `Scrolled ${direction} to ${after.y} px.`;
    },
  },
  {
    name: 'navigate',
    description: 'Open a web address in the active tab (or a new tab), or go back, forward, or reload.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) address; "https://" is added if missing.' },
        new_tab: { type: 'boolean', description: 'Open url in a new tab instead.' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
      },
    },
    async run(session, { url, new_tab = false, action }) {
      let ctx = await context(session);
      if (action) {
        const guest = needPage(ctx);
        const history = guest.navigationHistory;
        if (action === 'back' && !history.canGoBack()) throw new Error('There is no page to go back to.');
        if (action === 'forward' && !history.canGoForward()) throw new Error('There is no page to go forward to.');
        if (action === 'back') history.goBack();
        else if (action === 'forward') history.goForward();
        else guest.reload();
      } else if (url) {
        const href = webURL(url);
        await ctx.win.webContents.executeJavaScript(`netAI.${new_tab ? 'open' : 'navigate'}(${JSON.stringify(href)})`);
      } else {
        throw new Error('Give url, or action: back, forward or reload.');
      }
      ctx = await settle(session);
      return where(ctx);
    },
  },
  {
    name: 'tabs',
    description: 'List this window\'s tabs, or switch to tab number select.',
    inputSchema: { type: 'object', properties: { select: { type: 'integer', description: 'Tab number to switch to (1 = first).' } } },
    annotations: { readOnlyHint: true },
    async run(session, { select }) {
      let ctx = await context(session);
      if (select !== undefined && select !== null) {
        if (!(await ctx.win.webContents.executeJavaScript(`netAI.select(${Number(select)})`))) throw new Error(`There is no tab ${select}.`);
        ctx = await context(session);
      }
      return ctx.state.tabs
        .map((t) => `${t.active ? '→' : ' '} ${t.index}. ${t.isStart ? 'New tab' : `${t.title} — ${t.url}`}`)
        .join('\n');
    },
  },
];

module.exports = { start, stop, mcpConfig, isSynthetic };
