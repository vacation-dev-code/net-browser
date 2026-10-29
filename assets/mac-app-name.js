// Runs before `npm start` (package.json "prestart").
//
// On macOS the Dock label, ⌘Tab and the bold menu-bar name come from
// the app bundle's Info.plist, not from app.setName(). Unpackaged, that
// bundle is node_modules/electron/dist/Electron.app, so without this
// they say "Electron". Net.app (assets/build-mac-app.sh) has its own
// plist and does not need this. Idempotent; npm install undoes it.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const NAME = 'Net';

if (process.platform === 'darwin') {
  // require('electron') is .../Electron.app/Contents/MacOS/Electron.
  const plist = path.join(path.dirname(require('electron')), '..', 'Info.plist');
  if (fs.existsSync(plist)) {
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      const set = (op) => execFileSync('/usr/libexec/PlistBuddy', ['-c', op, plist], { stdio: 'ignore' });
      try { set(`Set :${key} ${NAME}`); } catch { set(`Add :${key} string ${NAME}`); }
    }
  }
}
