#!/bin/bash
# Net: build Net.app and install it into /Applications, so it shows up
# in Launchpad / Apps, Spotlight and Finder like any other app.
#
# Why this exists: `npm start` runs node_modules/electron/dist/
# Electron.app, which macOS lists nowhere — and whose Dock name and
# icon say "Electron". This copies that bundle to dist/Net.app, renames
# it (Info.plist, executable, icon) and puts the app's own files in
# Contents/Resources/app, which is where Electron looks for an app
# when it is not handed a path. No packager dependency needed.
#   bash assets/build-mac-app.sh            # build + install to /Applications
#   bash assets/build-mac-app.sh --no-install
# Re-run after changing the code: the installed app is a copy.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "$(uname)" == "Darwin" ]] || { echo "Net.app is macOS-only (Linux: see arch/)." >&2; exit 1; }
[[ -d node_modules/electron/dist/Electron.app ]] || npm install
[[ -f assets/Net.icns ]] || bash assets/make-icns.sh

APP="dist/Net.app"
PLIST="$APP/Contents/Info.plist"
rm -rf "$APP"
mkdir -p dist
cp -R node_modules/electron/dist/Electron.app "$APP"

mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Net"
rm -f "$APP/Contents/Resources/electron.icns" "$APP/Contents/Resources/default_app.asar"
cp assets/Net.icns "$APP/Contents/Resources/Net.icns"
set_plist() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
set_plist CFBundleName Net
set_plist CFBundleDisplayName Net
set_plist CFBundleExecutable Net
set_plist CFBundleIconFile Net.icns
set_plist CFBundleIdentifier dev.net.browser
set_plist CFBundleShortVersionString "$(node -p 'require("./package.json").version')"

DEST="$APP/Contents/Resources/app"
mkdir -p "$DEST"
cp -R main.js preload.js package.json renderer assets ai "$DEST/"
rm -f "$DEST/assets/"*.sh
# A local require the bundle is missing kills startup before any window
# opens (ai/ once was). Fail the build instead.
for mod in $(grep -o "require('\./[^']*')" main.js | sed "s/require('\.\/\(.*\)')/\1/"); do
  [[ -e "$DEST/$mod" || -e "$DEST/$mod.js" ]] || { echo "Net.app is missing $mod (required by main.js): add it to the copy above." >&2; exit 1; }
done
# Runtime dependencies only — electron itself is the bundle.
(cd "$DEST" && npm install --omit=dev --no-audit --no-fund >/dev/null)

# The copied bundle's signature no longer matches; re-sign ad hoc so
# Apple silicon will launch it.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "Built $APP"

if [[ "${1:-}" != "--no-install" ]]; then
  rm -rf /Applications/Net.app
  cp -R "$APP" /Applications/Net.app
  # Refresh Launch Services so Launchpad / Spotlight pick up name + icon.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Net.app
  echo "Installed /Applications/Net.app"
fi
