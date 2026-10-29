#!/bin/bash
# Build the Arch package for Net Browser v0.1.
#
# Why this script exists: makepkg needs a source tarball, and there
# is no release tarball yet — the project lives in a workspace, not
# a published repo. So this script makes the tarball from the
# current project tree, then runs makepkg in a clean build dir.
#
# Usage, from the project root:
#   bash arch/build-pkg.sh
# Output:
#   arch/build/net-browser-0.1.0-1-x86_64.pkg.tar.zst
# Install it with:
#   sudo pacman -U arch/build/net-browser-0.1.0-1-x86_64.pkg.tar.zst
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="0.1.0"
BUILD_DIR="$SCRIPT_DIR/build"
TARBALL_DIR="$BUILD_DIR/net-browser-$VERSION"

rm -rf "$BUILD_DIR"
mkdir -p "$TARBALL_DIR"

# Copy the app, excluding things that must not ship in a package:
# node_modules (reinstalled by the PKGBUILD without Electron),
# git metadata, and the build dir itself.
cd "$PROJECT_ROOT"
tar --exclude='./node_modules' \
    --exclude='./.git' \
    --exclude='./arch/build' \
    -cf - . | (cd "$TARBALL_DIR" && tar -xf -)

# makepkg sources: the tarball + the Arch files that live alongside
# the PKGBUILD. makepkg looks for them in the same directory as the
# PKGBUILD, so copy the PKGBUILD and its companions into the build dir.
cp "$SCRIPT_DIR/PKGBUILD" "$SCRIPT_DIR/net-browser.desktop" \
   "$SCRIPT_DIR/net-browser.png" "$SCRIPT_DIR/net-browser" "$BUILD_DIR/"
cd "$BUILD_DIR"
tar -czf "net-browser-$VERSION.tar.gz" "net-browser-$VERSION"

echo "==> Running makepkg (this runs npm install at build time)…"
makepkg --syncdeps --noconfirm

echo
echo "Built: $BUILD_DIR/net-browser-$VERSION-1-x86_64.pkg.tar.zst"
echo "Install: sudo pacman -U $BUILD_DIR/net-browser-$VERSION-1-x86_64.pkg.tar.zst"
