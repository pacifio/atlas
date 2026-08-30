#!/usr/bin/env bash
# ============================================================================
# Atlas — local (unsigned) .dmg for ONE macOS architecture.
#
# This is the developer build behind `bun run build:app:dmg[:arm|:intel]`. For a
# shippable, signed + notarized build use `scripts/release-macos.sh`, which is
# the only path that produces something Gatekeeper accepts on another Mac.
#
# Why a script instead of the target flag inline in package.json:
#
#   - it installs the missing rustup target instead of failing deep inside
#     cargo with "can't find crate for `std`", which is what you get the first
#     time you ask for Intel on an Apple Silicon machine;
#   - it stamps the icon onto THIS build's .dmg by path. `set-dmg-icon.sh` with
#     no arguments picks the newest .dmg anywhere under target/, which silently
#     stamps the wrong file once two architectures are in play;
#   - it exports SDKROOT, which the C-building dependencies need.
#
# Usage:
#   scripts/build-dmg.sh            # arm64 (default)
#   scripts/build-dmg.sh arm        # arm64
#   scripts/build-dmg.sh intel      # x86_64
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")/.."

case "${1:-arm}" in
  arm | arm64 | aarch64 | aarch64-apple-darwin)
    TARGET="aarch64-apple-darwin"
    ;;
  intel | x86 | x64 | x86_64 | x86_64-apple-darwin)
    TARGET="x86_64-apple-darwin"
    ;;
  *)
    echo "build-dmg: unknown architecture '${1}' — expected 'arm' or 'intel'" >&2
    exit 2
    ;;
esac

log() { printf "\033[1;34m[build-dmg]\033[0m %s\n" "$*"; }

# Cross-compiling to the other arch needs its std; rustup is the only thing that
# can supply it, and the cargo error when it is missing does not say so.
if ! rustup target list --installed | grep -qx "${TARGET}"; then
  log "Installing missing rust target ${TARGET}"
  rustup target add "${TARGET}"
fi

# The C-building dependencies need an SDK path. The macOS SDK is universal, so
# the same root serves both architectures — this is about it being SET, not
# about which arch it points at.
export SDKROOT="${SDKROOT:-$(xcrun --show-sdk-path)}"

log "Building Atlas for ${TARGET}"
node scripts/with-posthog-env.mjs tauri build --target "${TARGET}" --bundles app,dmg

# Cargo's target dir is the workspace root's `target/`, not
# `src-tauri/target/` — the repo became a cargo workspace in #38.
DMG_DIR="target/${TARGET}/release/bundle/dmg"
DMG_PATH="$(ls -t "${DMG_DIR}"/*.dmg 2>/dev/null | head -n1 || true)"
if [[ -z "${DMG_PATH}" ]]; then
  echo "build-dmg: no .dmg produced under ${DMG_DIR}" >&2
  exit 1
fi

# By path, not by "newest anywhere" — see the header.
bash scripts/set-dmg-icon.sh src-tauri/icons/icon.icns "${DMG_PATH}"

log "Done: ${DMG_PATH}"
log "Unsigned — for a shippable build use scripts/release-macos.sh"
