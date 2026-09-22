#!/usr/bin/env bash
# ============================================================================
# Atlas — Linux packaging script
#
# Generates:
#   1. Standalone portable tarball (atlas-<version>-linux-<arch>.tar.gz)
#      with binary, desktop integration, icons, licenses, and installer scripts.
#   2. AUR `atlas-bin` PKGBUILD with calculated checksums.
#
# Usage:
#   scripts/package-linux.sh [x86_64|aarch64]
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

ARCH="${1:-x86_64}"
case "$ARCH" in
  x86_64|x64|amd64)
    ARCH="x86_64"
    DEB_ARCH="amd64"
    RPM_ARCH="x86_64"
    RUST_TARGET="x86_64-unknown-linux-gnu"
    ;;
  aarch64|arm64)
    ARCH="aarch64"
    DEB_ARCH="arm64"
    RPM_ARCH="aarch64"
    RUST_TARGET="aarch64-unknown-linux-gnu"
    ;;
  *)
    echo "Unknown architecture: $ARCH" >&2
    exit 1
    ;;
esac

# Extract version from package.json
VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')"
VERSION="${VERSION#alpha-}"
VERSION="${VERSION#exp-}"
VERSION="${VERSION#v}"
RELEASE_TAG="${RELEASE_TAG:-alpha-${VERSION}}"
echo "Packaging Atlas v${VERSION} for Linux (${ARCH}) [tag: ${RELEASE_TAG}]..."

# Locate binary
ATLAS_BIN="${ATLAS_BIN:-}"
if [ -z "$ATLAS_BIN" ]; then
  CANDIDATES=(
    "target/release/atlas"
    "target/${RUST_TARGET}/release/atlas"
  )
  for c in "${CANDIDATES[@]}"; do
    if [ -f "$c" ] && [ -x "$c" ]; then
      ATLAS_BIN="$c"
      break
    fi
  done
fi

if [ -z "$ATLAS_BIN" ] || [ ! -f "$ATLAS_BIN" ]; then
  echo "WARNING: atlas binary not found in standard target locations."
  echo "You can set ATLAS_BIN=/path/to/atlas before running this script."
  # If running in dummy/test mode without binary, create a placeholder if requested
  if [ "${CREATE_DUMMY_BIN:-0}" = "1" ]; then
    mkdir -p target/release
    ATLAS_BIN="target/release/atlas"
    echo '#!/bin/sh' > "$ATLAS_BIN"
    echo 'echo "Atlas"' >> "$ATLAS_BIN"
    chmod +x "$ATLAS_BIN"
  else
    echo "Error: Atlas binary required for packaging." >&2
    exit 1
  fi
fi

OUTPUT_DIR="${ROOT_DIR}/dist/release-linux"
rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

STAGE_DIR="${OUTPUT_DIR}/atlas-${VERSION}"
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}/bin"
mkdir -p "${STAGE_DIR}/share/applications"
mkdir -p "${STAGE_DIR}/share/licenses/atlas"

# 1. Copy binary and create atl/tryatlas symlinks
cp "$ATLAS_BIN" "${STAGE_DIR}/bin/atlas"
chmod 755 "${STAGE_DIR}/bin/atlas"
ln -sf atlas "${STAGE_DIR}/bin/atl"
ln -sf atlas "${STAGE_DIR}/bin/tryatlas"

# 2. Copy desktop file
cp "src-tauri/resources/dev.atlas.ide.desktop" "${STAGE_DIR}/share/applications/"
chmod 644 "${STAGE_DIR}/share/applications/dev.atlas.ide.desktop"

# 3. Copy icons into hicolor theme hierarchy
mkdir -p "${STAGE_DIR}/share/icons/hicolor/32x32/apps"
mkdir -p "${STAGE_DIR}/share/icons/hicolor/64x64/apps"
mkdir -p "${STAGE_DIR}/share/icons/hicolor/128x128/apps"
mkdir -p "${STAGE_DIR}/share/icons/hicolor/256x256/apps"
mkdir -p "${STAGE_DIR}/share/icons/hicolor/512x512/apps"

[ -f "src-tauri/icons/32x32.png" ] && cp "src-tauri/icons/32x32.png" "${STAGE_DIR}/share/icons/hicolor/32x32/apps/atlas.png"
[ -f "src-tauri/icons/64x64.png" ] && cp "src-tauri/icons/64x64.png" "${STAGE_DIR}/share/icons/hicolor/64x64/apps/atlas.png"
[ -f "src-tauri/icons/128x128.png" ] && cp "src-tauri/icons/128x128.png" "${STAGE_DIR}/share/icons/hicolor/128x128/apps/atlas.png"
[ -f "src-tauri/icons/128x128@2x.png" ] && cp "src-tauri/icons/128x128@2x.png" "${STAGE_DIR}/share/icons/hicolor/256x256/apps/atlas.png"
[ -f "src-tauri/icons/icon.png" ] && cp "src-tauri/icons/icon.png" "${STAGE_DIR}/share/icons/hicolor/512x512/apps/atlas.png"

# 4. Copy licenses
[ -f "LICENSE" ] && cp "LICENSE" "${STAGE_DIR}/share/licenses/atlas/LICENSE"
if [ -d "src-tauri/licenses" ]; then
  cp src-tauri/licenses/* "${STAGE_DIR}/share/licenses/atlas/"
fi

# 5. Add installer & uninstaller scripts
cat <<'EOF' > "${STAGE_DIR}/install.sh"
#!/usr/bin/env bash
set -euo pipefail
PREFIX="${PREFIX:-/usr/local}"
if [ "$EUID" -ne 0 ] && [ "$PREFIX" = "/usr/local" ]; then
  PREFIX="${HOME}/.local"
fi
echo "Installing Atlas to ${PREFIX}..."
install -d "${PREFIX}/bin" "${PREFIX}/share/applications" "${PREFIX}/share/licenses/atlas"
install -m 755 bin/atlas "${PREFIX}/bin/atl"
ln -sf atl "${PREFIX}/bin/tryatlas"
if [ ! -e "${PREFIX}/bin/atlas" ]; then
  ln -sf atl "${PREFIX}/bin/atlas"
fi
# Remove legacy desktop launcher aliases if present from earlier versions
rm -f "${PREFIX}/share/applications/atlas.desktop" "${PREFIX}/share/applications/atl.desktop" "${PREFIX}/share/applications/tryatlas.desktop"
install -m 644 share/applications/dev.atlas.ide.desktop "${PREFIX}/share/applications/dev.atlas.ide.desktop"
cp -r share/icons "${PREFIX}/share/"
cp -r share/licenses/atlas/* "${PREFIX}/share/licenses/atlas/"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${PREFIX}/share/applications" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t "${PREFIX}/share/icons/hicolor" 2>/dev/null || true
fi
echo "Atlas installed successfully to ${PREFIX}! (run 'atl' or 'tryatlas')"
EOF
chmod 755 "${STAGE_DIR}/install.sh"

cat <<'EOF' > "${STAGE_DIR}/uninstall.sh"
#!/usr/bin/env bash
set -euo pipefail
PREFIX="${PREFIX:-/usr/local}"
if [ "$EUID" -ne 0 ] && [ "$PREFIX" = "/usr/local" ]; then
  PREFIX="${HOME}/.local"
fi
echo "Uninstalling Atlas from ${PREFIX}..."
rm -f "${PREFIX}/bin/atl"
rm -f "${PREFIX}/bin/tryatlas"
if [ -L "${PREFIX}/bin/atlas" ]; then
  rm -f "${PREFIX}/bin/atlas"
fi
rm -f "${PREFIX}/share/applications/dev.atlas.ide.desktop"
rm -f "${PREFIX}/share/applications/atlas.desktop"
rm -f "${PREFIX}/share/applications/atl.desktop"
rm -f "${PREFIX}/share/applications/tryatlas.desktop"
for size in 32 64 128 256 512; do
  rm -f "${PREFIX}/share/icons/hicolor/${size}x${size}/apps/atlas.png"
done
rm -rf "${PREFIX}/share/licenses/atlas"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${PREFIX}/share/applications" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t "${PREFIX}/share/icons/hicolor" 2>/dev/null || true
fi
echo "Atlas uninstalled."
EOF
chmod 755 "${STAGE_DIR}/uninstall.sh"

# 6. Create tarball
TARBALL_NAME="atlas-${VERSION}-linux-${ARCH}.tar.gz"
TARBALL_PATH="${OUTPUT_DIR}/${TARBALL_NAME}"
tar -czf "${TARBALL_PATH}" -C "${OUTPUT_DIR}" "atlas-${VERSION}"
echo "Created standalone tarball: ${TARBALL_PATH}"

# Calculate SHA256 of the tarball
TARBALL_SHA256="$(sha256sum "${TARBALL_PATH}" | awk '{print $1}')"
echo "Tarball SHA256: ${TARBALL_SHA256}"

# 7. Generate AUR PKGBUILD
AUR_DIR="${OUTPUT_DIR}/aur-tryatlas-bin"
mkdir -p "${AUR_DIR}"
REPO="${GITHUB_REPOSITORY:-pacifio/atlas}"

cat <<EOF > "${AUR_DIR}/PKGBUILD"
# Maintainer: Atlas Team <contact@tryatlas.cc>
pkgname=tryatlas-bin
_pkgname=atlas
pkgver=${VERSION}
pkgrel=1
pkgdesc="Atlas — agent-first ideation and planning tool"
arch=('${ARCH}')
url="https://tryatlas.cc"
license=('Apache-2.0')
depends=(
    'webkit2gtk-4.1'
    'gtk3'
    'libayatana-appindicator'
    'bubblewrap'
    'openssl'
)
optdepends=(
    'xdg-terminal-exec: Open folders in default terminal'
    'wl-clipboard: Wayland clipboard support'
    'xclip: X11 clipboard support'
    'xsel: Alternative X11 clipboard support'
)
provides=("tryatlas=\${pkgver}" "atl=\${pkgver}")
source_${ARCH}=("atlas-\${pkgver}-linux-${ARCH}.tar.gz::https://github.com/${REPO}/releases/download/${RELEASE_TAG}/atlas-\${pkgver}-linux-${ARCH}.tar.gz")
sha256sums_${ARCH}=('${TARBALL_SHA256}')

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
EOF

# Copy tarball to AUR dir so makepkg can build offline/locally
cp "${TARBALL_PATH}" "${AUR_DIR}/"


echo "Created AUR PKGBUILD: ${AUR_DIR}/PKGBUILD"

# 8. Generate conflict-free Debian package (tryatlas_<version>_<arch>.deb)
echo "Building conflict-free Debian package (tryatlas_${VERSION}_${DEB_ARCH}.deb)..."
DEB_STAGING="${OUTPUT_DIR}/deb-staging"
rm -rf "${DEB_STAGING}"
mkdir -p "${DEB_STAGING}/DEBIAN"
mkdir -p "${DEB_STAGING}/usr/bin"
mkdir -p "${DEB_STAGING}/usr/share/applications"
mkdir -p "${DEB_STAGING}/usr/share/icons"
mkdir -p "${DEB_STAGING}/usr/share/licenses/tryatlas"

# Payload installs /usr/bin/atl and symlinks /usr/bin/tryatlas (does NOT claim /usr/bin/atlas in package index)
cp "${STAGE_DIR}/bin/atlas" "${DEB_STAGING}/usr/bin/atl"
chmod 755 "${DEB_STAGING}/usr/bin/atl"
ln -sf atl "${DEB_STAGING}/usr/bin/tryatlas"

# Desktop integration & icons
cp -r "${STAGE_DIR}/share/applications/"* "${DEB_STAGING}/usr/share/applications/"
cp -r "${STAGE_DIR}/share/icons/"* "${DEB_STAGING}/usr/share/icons/"
cp -r "${STAGE_DIR}/share/licenses/atlas/"* "${DEB_STAGING}/usr/share/licenses/tryatlas/"

cat <<EOF > "${DEB_STAGING}/DEBIAN/control"
Package: tryatlas
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${DEB_ARCH}
Maintainer: Atlas Team <contact@tryatlas.cc>
Depends: libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1, bubblewrap, libglib2.0-0
Suggests: wl-clipboard, xclip, xsel
Provides: tryatlas (= ${VERSION}), atl (= ${VERSION})
Description: Atlas — agent-first ideation and planning tool
 Atlas is an agent-first IDE and planning tool for software development.
EOF

cat <<'EOF' > "${DEB_STAGING}/DEBIAN/postinst"
#!/bin/sh
set -e
if [ ! -e /usr/bin/atlas ]; then
  ln -sf atl /usr/bin/atlas
fi
# Remove legacy desktop launcher aliases if present from earlier versions
rm -f /usr/share/applications/atlas.desktop /usr/share/applications/atl.desktop /usr/share/applications/tryatlas.desktop
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
fi
EOF
chmod 755 "${DEB_STAGING}/DEBIAN/postinst"

cat <<'EOF' > "${DEB_STAGING}/DEBIAN/postrm"
#!/bin/sh
set -e
if [ -L /usr/bin/atlas ] && [ "$(readlink /usr/bin/atlas)" = "atl" ]; then
  rm -f /usr/bin/atlas
fi
rm -f /usr/share/applications/atlas.desktop /usr/share/applications/atl.desktop /usr/share/applications/tryatlas.desktop
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
fi
EOF
chmod 755 "${DEB_STAGING}/DEBIAN/postrm"

DEB_FILE="${OUTPUT_DIR}/tryatlas_${VERSION}_${DEB_ARCH}.deb"
if command -v dpkg-deb >/dev/null 2>&1; then
  dpkg-deb --build "${DEB_STAGING}" "${DEB_FILE}"
else
  echo "2.0" > "${DEB_STAGING}/debian-binary"
  tar -czf "${DEB_STAGING}/control.tar.gz" -C "${DEB_STAGING}/DEBIAN" .
  tar -czf "${DEB_STAGING}/data.tar.gz" -C "${DEB_STAGING}" --exclude=DEBIAN --exclude=debian-binary --exclude=control.tar.gz --exclude=data.tar.gz usr
  ar -rc "${DEB_FILE}" "${DEB_STAGING}/debian-binary" "${DEB_STAGING}/control.tar.gz" "${DEB_STAGING}/data.tar.gz"
fi
rm -rf "${DEB_STAGING}"
echo "Created conflict-free Debian package: ${DEB_FILE}"

# 9. Generate conflict-free RPM package (tryatlas-<version>-1.<arch>.rpm)
if command -v rpmbuild >/dev/null 2>&1; then
  echo "Building conflict-free RPM package (tryatlas-${VERSION}-1.${RPM_ARCH}.rpm)..."
  RPM_TOPDIR="${OUTPUT_DIR}/rpmbuild"
  rm -rf "${RPM_TOPDIR}"
  mkdir -p "${RPM_TOPDIR}"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}

  cat <<EOF > "${RPM_TOPDIR}/SPECS/tryatlas.spec"
%global _enable_debug_package 0
%global debug_package %{nil}
%global __os_install_post %{nil}

Name:           tryatlas
Version:        ${VERSION}
Release:        1%{?dist}
Summary:        Atlas — agent-first ideation and planning tool
License:        Apache-2.0
URL:            https://tryatlas.cc
Provides:       tryatlas = %{version}-%{release}
Provides:       atl = %{version}-%{release}
AutoReqProv:    no
Requires:       webkit2gtk4.1, gtk3, libayatana-appindicator-gtk3, bubblewrap, glib2

%description
Atlas is an agent-first IDE and planning tool for software development.

%install
mkdir -p %{buildroot}/usr/bin
mkdir -p %{buildroot}/usr/share/applications
mkdir -p %{buildroot}/usr/share/icons/hicolor
mkdir -p %{buildroot}/usr/share/licenses/tryatlas

install -m 755 ${STAGE_DIR}/bin/atlas %{buildroot}/usr/bin/atl
ln -sf atl %{buildroot}/usr/bin/tryatlas
cp -r ${STAGE_DIR}/share/applications/* %{buildroot}/usr/share/applications/
cp -r ${STAGE_DIR}/share/icons/hicolor/* %{buildroot}/usr/share/icons/hicolor/
cp -r ${STAGE_DIR}/share/licenses/atlas/* %{buildroot}/usr/share/licenses/tryatlas/

%post
if [ ! -e /usr/bin/atlas ]; then
  ln -sf atl /usr/bin/atlas
fi
# Remove legacy desktop launcher aliases if present from earlier versions
rm -f /usr/share/applications/atlas.desktop /usr/share/applications/atl.desktop /usr/share/applications/tryatlas.desktop
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
fi

%postun
if [ -L /usr/bin/atlas ] && [ "\$(readlink /usr/bin/atlas)" = "atl" ]; then
  rm -f /usr/bin/atlas
fi
rm -f /usr/share/applications/atlas.desktop /usr/share/applications/atl.desktop /usr/share/applications/tryatlas.desktop
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
fi

%files
/usr/bin/atl
/usr/bin/tryatlas
/usr/share/applications/*.desktop
/usr/share/icons/hicolor/*/apps/atlas.png
/usr/share/licenses/tryatlas/*
EOF

  rpmbuild --define "_topdir ${RPM_TOPDIR}" -bb "${RPM_TOPDIR}/SPECS/tryatlas.spec"
  cp "${RPM_TOPDIR}"/RPMS/*/*.rpm "${OUTPUT_DIR}/"
  rm -rf "${RPM_TOPDIR}"
  echo "Created conflict-free RPM package in ${OUTPUT_DIR}"
else
  echo "rpmbuild not available, skipping RPM package generation"
fi

echo "Packaging complete in ${OUTPUT_DIR}"
