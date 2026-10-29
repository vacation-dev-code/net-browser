#!/usr/bin/env bash
# Launch Net Browser on macOS or Linux. Installs dependencies on first run.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Net Browser needs Node.js and npm." >&2
  echo "  macOS: brew install node" >&2
  echo "  Arch:  bash arch/install-arch.sh   (or: sudo pacman -S nodejs npm)" >&2
  exit 1
fi

# First run, or package.json changed (a git pull that added a dependency).
if [[ ! -f node_modules/.package-lock.json || package.json -nt node_modules/.package-lock.json ]]; then
  npm install
fi

exec npm start
