#!/usr/bin/env bash
# Builds the tryatlas deb with cargo-deb, from the binary `bun run
# build:app:linux` already produced, into target/debian/.
#
# This is the local path. The release deb is built by scripts/package-linux.sh
# with dpkg-deb and verified by release-linux.yml; both install the same files
# under the same package name, and their shared parts (the maintainer scripts
# in scripts/linux/deb/, the dependency list) are kept in step by
# tests/linux-packaging.test.ts. What differs: cargo-deb derives the shared
# library dependencies and the glibc floor with dpkg-shlibdeps (`$auto`),
# where the release script names the libraries and reads the floor itself.
#
# Usage: scripts/linux/cargo-deb.sh [--build] [--install]
#   --build    run `bun run build:app:linux` first
#   --install  install the result with apt afterwards (asks for sudo)
#
# Needs: cargo-deb (`cargo install cargo-deb`), dpkg-dev (for dpkg-shlibdeps).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

BUILD=0
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --install) INSTALL=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v cargo-deb >/dev/null 2>&1 || { echo "cargo-deb is not installed: cargo install cargo-deb" >&2; exit 1; }
command -v dpkg-shlibdeps >/dev/null 2>&1 || { echo "dpkg-shlibdeps is not installed (apt install dpkg-dev); \$auto depends need it" >&2; exit 1; }

if [ "$BUILD" = 1 ]; then
  bun run build:app:linux
fi

BIN="target/release/atlas"
if [ ! -x "$BIN" ]; then
  echo "no $BIN: run with --build, or bun run build:app:linux first" >&2
  exit 1
fi
# A tauri build embeds the frontend; a plain cargo build does not, and the
# app would open to a blank window. Refuse a binary that has no bundle in it.
if ! grep -q 'tauri://localhost' "$BIN" 2>/dev/null; then
  echo "$BIN was not built by tauri (no embedded frontend): use --build" >&2
  exit 1
fi

# --no-build: the binary is tauri's, above. --no-strip: the release profile
# already strips, and cargo-deb would otherwise shell out to strip again.
cargo deb -p atlas --no-build --no-strip -o target/debian/

DEB="$(ls -t target/debian/tryatlas_*.deb | head -n 1)"
echo
echo "Built $DEB"
dpkg-deb --info "$DEB" | sed -n '/Package:/,/Description:/p'

if [ "$INSTALL" = 1 ]; then
  sudo apt install --reinstall "./$DEB"
else
  echo
  echo "Install with: sudo apt install --reinstall ./$DEB"
fi
