#!/usr/bin/env bash
# ============================================================================
# Stamp a custom Finder icon onto a built Atlas .dmg.
#
# Tauri's DmgConfig (bundle.macOS.dmg in tauri.conf.json) has no icon field —
# it only controls window background/size/icon-positions inside the mounted
# volume. The .dmg file itself always gets macOS's generic disk-image icon
# unless something sets it explicitly. This uses the classic resource-fork
# trick (sips seeds the icns, DeRez/Rez transplant that icon resource onto
# the target file, SetFile flags it as custom) — works directly on the
# finished file, no hdiutil remount needed.
#
# Run this BEFORE codesigning the dmg — codesign should see the final bytes.
#
# Usage:
#   scripts/set-dmg-icon.sh [path/to/icon.icns] [path/to/target.dmg]
#
# With no args: uses src-tauri/icons/icon.icns and the most recently built
# .dmg under src-tauri/target/**/release/bundle/dmg/.
# ============================================================================

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icon="${1:-${root}/src-tauri/icons/icon.icns}"

if [[ -n "${2:-}" ]]; then
  dmg="$2"
else
  dmg="$(find "${root}/src-tauri/target" -path "*/release/bundle/dmg/*.dmg" -type f -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -n1 || true)"
fi

if [[ -z "${dmg}" || ! -f "${dmg}" ]]; then
  echo "set-dmg-icon: no .dmg found (build one first)" >&2
  exit 1
fi
if [[ ! -f "${icon}" ]]; then
  echo "set-dmg-icon: icon not found at ${icon}" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

cp "${icon}" "${tmp}/icon.icns"
sips -i "${tmp}/icon.icns" >/dev/null
DeRez -only icns "${tmp}/icon.icns" > "${tmp}/icon.rsrc"
Rez -append "${tmp}/icon.rsrc" -o "${dmg}"
SetFile -a C "${dmg}"

echo "set-dmg-icon: applied $(basename "${icon}") to $(basename "${dmg}")"
