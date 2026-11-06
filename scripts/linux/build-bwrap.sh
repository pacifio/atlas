#!/usr/bin/env bash
# Build the bubblewrap the AppImage carries, from a pinned upstream release.
#
# Why: the native agent's sandbox execs `bwrap` (crates/atlas-native-agent,
# `linux_sandbox`). The deb, rpm and Arch package depend on the distro's
# bubblewrap, but an AppImage can declare nothing, so on a machine without
# the package every sandboxed command failed. The engine already looks for a
# bundled `bwrap` next to its executable and prefers the system one when
# there is one, so this only ever fills the gap.
#
# Not digest-pinned in the binary (the engine's ATLAS_AGENT_BWRAP_SHA256):
# the bundled bwrap ships inside the same image as the binary that would
# check it, so anyone able to swap one can swap both, and the AppImage
# bundler may rewrite the ELF's rpath, which would fail a digest that
# protected nothing.
#
# Usage: scripts/linux/build-bwrap.sh <out dir> <rust target triple>
# Writes <out>/bwrap-<triple> (Tauri's externalBin naming),
#        <out>/bubblewrap-LICENSE.txt (LGPL-2.1+, shipped beside it), and
#        <out>/tauri.bwrap.conf.json, the config overlay that bundles both:
#        pass it to `tauri build` as a second --config.
# Needs: curl, meson, ninja, a C compiler, libcap's headers (libcap-dev).
set -euo pipefail

BWRAP_VERSION="0.13.1"
# GitHub's recorded digest for the release asset, checked against a download
# on 2026-11-03.
BWRAP_SHA256="0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d"
BWRAP_URL="https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VERSION}/bubblewrap-${BWRAP_VERSION}.tar.xz"

if [ $# -ne 2 ]; then
  echo "usage: $0 <out dir> <rust target triple>" >&2
  exit 2
fi
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
TRIPLE="$2"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL --retry 3 -o "$WORK/bwrap.tar.xz" "$BWRAP_URL"
echo "${BWRAP_SHA256}  $WORK/bwrap.tar.xz" | sha256sum -c -
tar -xJf "$WORK/bwrap.tar.xz" -C "$WORK"
SRC="$WORK/bubblewrap-${BWRAP_VERSION}"

# No SELinux (a distro without it would lack the library), no man pages or
# tests (not shipped).
meson setup "$WORK/build" "$SRC" --buildtype=release \
  -Dselinux=disabled -Dman=disabled -Dtests=false
meson compile -C "$WORK/build" bwrap

install -m 755 "$WORK/build/bwrap" "$OUT/bwrap-${TRIPLE}"
install -m 644 "$SRC/LICENSE" "$OUT/bubblewrap-LICENSE.txt"
"$OUT/bwrap-${TRIPLE}" --version

# Paths are relative to src-tauri/, where tauri.conf.json lives.
REL="$(realpath --relative-to="$(dirname "$0")/../../src-tauri" "$OUT")"
cat >"$OUT/tauri.bwrap.conf.json" <<JSON
{
  "bundle": {
    "externalBin": ["${REL}/bwrap"],
    "resources": {
      "${REL}/bubblewrap-LICENSE.txt": "licenses/bubblewrap-LICENSE.txt"
    }
  }
}
JSON
echo "Built bubblewrap ${BWRAP_VERSION} for ${TRIPLE} into ${OUT}"
