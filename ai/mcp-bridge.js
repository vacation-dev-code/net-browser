// Claude Code starts this as its "net-browser" MCP server (stdio), using
// Electron's own binary in Node mode (ELECTRON_RUN_AS_NODE=1). All it
// does is pipe Claude Code's stdin/stdout to Net Browser's Unix socket
// (ai/browser-tools.js), introducing itself first with this launch's
// token and the window it belongs to.
const net = require('node:net');

const { NET_BROWSER_SOCKET, NET_BROWSER_TOKEN, NET_BROWSER_WINDOW } = process.env;

const conn = net.connect(NET_BROWSER_SOCKET, () => {
  conn.write(JSON.stringify({ token: NET_BROWSER_TOKEN, window: Number(NET_BROWSER_WINDOW) }) + '\n');
  process.stdin.pipe(conn);
  conn.pipe(process.stdout);
});
conn.on('error', (err) => {
  process.stderr.write(`net-browser: cannot reach Net Browser (${err.message}). Is it still running?\n`);
  process.exit(1);
});
conn.on('close', () => process.exit(0));
process.stdin.on('end', () => conn.end());
