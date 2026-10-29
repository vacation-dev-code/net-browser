#!/bin/bash
# Net Browser v0.1 — quick install on Arch Linux.
#
# This is the "just run it" route. For a proper system package,
# see arch/PKGBUILD + arch/build-pkg.sh instead.
#
# What it does:
#   1. Installs system deps with pacman (nodejs, npm, git).
#      It does NOT install system Electron — npm install below
#      bundles Electron, so the version in package.json is the
#      version you actually run, regardless of Arch's electron
#      package version that week.
#   2. npm install (Electron + the Ghostery ad blocker; filter lists
#      download on first launch)
#
# Run from the project root, or from arch/ — the script finds
# the project root itself:
#   bash arch/install-arch.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ ! -f /etc/arch-release ]]; then
  echo "This script is for Arch Linux (/etc/arch-release not found)."
  echo "On another distro, just run: npm install && npm start"
  exit 1
fi

echo "==> Installing system dependencies (pacman)…"
sudo pacman -S --needed --noconfirm nodejs npm git

echo "==> Installing Net Browser dependencies (npm)…"
npm install


cat << 'EOF'

Done. Run Net Browser with:

  npm start

Wayland users: if the window looks wrong, try:
  ELECTRON_OZONE_PLATFORM_HINT=auto npm start

No compositor (no blur)? The glass falls back to a translucent
panel — see README-arch.md, or run with NET_BROWSER_OPAQUE=1
for a native frame instead of the frameless glass window.
EOF
