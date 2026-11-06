#!/usr/bin/env bash
# Write the AUR `tryatlas-bin` PKGBUILD for every architecture whose tarball
# is in <dir>, with each tarball's sha256.
#
# Usage: scripts/linux/aur-pkgbuild.sh <dir with atlas-<ver>-linux-<arch>.tar.gz> <out PKGBUILD>
# Environment: VERSION, RELEASE_TAG (required); GITHUB_REPOSITORY (default tryatlas/atlas)
#
# package-linux.sh calls it for the one arch it just packaged, so makepkg can
# build the Arch package from it; release-linux.yml's publish job calls it
# again with every arch's tarball, and that multi-arch file is what ships.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <tarball dir> <out PKGBUILD>" >&2
  exit 2
fi
DIR="$1"
OUT="$2"
: "${VERSION:?VERSION is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
REPO="${GITHUB_REPOSITORY:-tryatlas/atlas}"

ARCHES=()
SOURCES=""
for arch in x86_64 aarch64; do
  tarball="${DIR}/atlas-${VERSION}-linux-${arch}.tar.gz"
  [ -f "$tarball" ] || continue
  ARCHES+=("'${arch}'")
  sha="$(sha256sum "$tarball" | awk '{print $1}')"
  SOURCES+="source_${arch}=(\"atlas-\${pkgver}-linux-${arch}.tar.gz::https://github.com/${REPO}/releases/download/${RELEASE_TAG}/atlas-\${pkgver}-linux-${arch}.tar.gz\")"$'\n'
  SOURCES+="sha256sums_${arch}=('${sha}')"$'\n'
done
if [ "${#ARCHES[@]}" -eq 0 ]; then
  echo "no atlas-${VERSION}-linux-<arch>.tar.gz in ${DIR}" >&2
  exit 1
fi

# One place for the runtime dependencies of every package format.
# shellcheck source=scripts/linux/runtime-deps.sh
. "$(dirname "$0")/runtime-deps.sh"

mkdir -p "$(dirname "$OUT")"
cat <<PKGBUILD >"$OUT"
# Maintainer: Atlas Team <contact@tryatlas.cc>
pkgname=tryatlas-bin
_pkgname=atlas
pkgver=${VERSION}
pkgrel=1
pkgdesc="Atlas — agent-first ideation and planning tool"
arch=(${ARCHES[*]})
url="https://tryatlas.cc"
license=('Apache-2.0')
depends=(
$(for d in "${ARCH_DEPENDS[@]}"; do printf "    '%s'\n" "$d"; done)
)
optdepends=(
    'xdg-terminal-exec: Open folders in default terminal'
    'wl-clipboard: Wayland clipboard support'
    'xclip: X11 clipboard support'
    'xsel: Alternative X11 clipboard support'
)
provides=("tryatlas=\${pkgver}" "atl=\${pkgver}")
options=('!strip' '!debug')
${SOURCES}
package() {
    cd "\${srcdir}/atlas-\${pkgver}"
    install -Dm755 bin/atlas "\${pkgdir}/usr/bin/atl"
    ln -sf atl "\${pkgdir}/usr/bin/tryatlas"
    install -Dm644 share/applications/dev.atlas.ide.desktop "\${pkgdir}/usr/share/applications/dev.atlas.ide.desktop"
    for size in 32 64 128 256 512; do
        if [ -f "share/icons/hicolor/\${size}x\${size}/apps/atlas.png" ]; then
            install -Dm644 "share/icons/hicolor/\${size}x\${size}/apps/atlas.png" \\
                "\${pkgdir}/usr/share/icons/hicolor/\${size}x\${size}/apps/atlas.png"
        fi
    done
    install -d "\${pkgdir}/usr/share/licenses/\${pkgname}"
    install -m644 share/licenses/atlas/* "\${pkgdir}/usr/share/licenses/\${pkgname}/"
}
PKGBUILD
echo "Wrote ${OUT} for ${ARCHES[*]}"
