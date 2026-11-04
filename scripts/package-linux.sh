#!/usr/bin/env bash
# ============================================================================
# Atlas — Linux packaging script
#
# Generates:
#   1. Standalone portable tarball (atlas-<version>-linux-<arch>.tar.gz)
#      with binary, desktop integration, icons, licenses, and installer scripts.
#   2. AUR `tryatlas-bin` PKGBUILD with calculated checksums.
#   3. Conflict-free deb and rpm (`tryatlas`, installing `atl`).
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

# Extract version from environment or package.json
VERSION="${VERSION:-$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')}"
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

# The runtime dependencies of every package format, from one list.
# shellcheck source=scripts/linux/runtime-deps.sh
. "${ROOT_DIR}/scripts/linux/runtime-deps.sh"
join_by() {
  local sep="$1"
  shift
  local out="$1"
  shift
  for item in "$@"; do out+="${sep}${item}"; done
  printf '%s' "$out"
}

# The newest glibc symbol version the binary needs: its real libc floor,
# which the deb states as `libc6 (>= …)` rather than leaving it implicit.
GLIBC_NEEDED="$(objdump -T "$ATLAS_BIN" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -n 1)"
if [ -z "$GLIBC_NEEDED" ]; then
  echo "Error: could not read the binary's glibc requirement (objdump -T)" >&2
  exit 1
fi

# Under target/, with the binary, not under dist/. `dist/` is the frontend
# bundle: `scripts/build-frontend.mjs` syncs it to Vite's output before every
# build, deleting whatever else is there, and `tauri-build` watches all of it,
# so packages staged there were wiped and relinked the app on the next build.
# `cargo clean` removes this with the rest of the build output.
OUTPUT_DIR="${ROOT_DIR}/target/release-linux"
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
# `atlas` belongs to the standalone Atlas CLI; drop the alias earlier versions made
if [ -L "${PREFIX}/bin/atlas" ] && [ "$(readlink "${PREFIX}/bin/atlas")" = "atl" ]; then
  rm -f "${PREFIX}/bin/atlas"
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
# The deb, rpm and Arch package pull bubblewrap in; a tarball cannot.
if ! command -v bwrap >/dev/null 2>&1; then
  echo "Note: bubblewrap (bwrap) is not installed. Atlas's agent needs it to run"
  echo "commands. Install your distribution's 'bubblewrap' package."
fi
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

# 7. Generate AUR PKGBUILD (this arch only; the release's publish job writes
#    the multi-arch one that ships)
AUR_DIR="${OUTPUT_DIR}/aur-tryatlas-bin"
VERSION="${VERSION}" RELEASE_TAG="${RELEASE_TAG}" \
  "${ROOT_DIR}/scripts/linux/aur-pkgbuild.sh" "${OUTPUT_DIR}" "${AUR_DIR}/PKGBUILD"

# Copy tarball to AUR dir so makepkg can build offline/locally
cp "${TARBALL_PATH}" "${AUR_DIR}/"


# 8. Generate conflict-free Debian package (tryatlas_<version>_<arch>.deb)
echo "Building conflict-free Debian package (tryatlas_${VERSION}_${DEB_ARCH}.deb)..."
DEB_STAGING="${OUTPUT_DIR}/deb-staging"
rm -rf "${DEB_STAGING}"
mkdir -p "${DEB_STAGING}/DEBIAN"
mkdir -p "${DEB_STAGING}/usr/bin"
mkdir -p "${DEB_STAGING}/usr/share/applications"
mkdir -p "${DEB_STAGING}/usr/share/icons"
mkdir -p "${DEB_STAGING}/usr/share/licenses/tryatlas"
mkdir -p "${DEB_STAGING}/usr/share/doc/tryatlas"

# Payload installs /usr/bin/atl and symlinks /usr/bin/tryatlas (does NOT claim /usr/bin/atlas in package index)
cp "${STAGE_DIR}/bin/atlas" "${DEB_STAGING}/usr/bin/atl"
chmod 755 "${DEB_STAGING}/usr/bin/atl"
ln -sf atl "${DEB_STAGING}/usr/bin/tryatlas"

# Desktop integration & icons
cp -r "${STAGE_DIR}/share/applications/"* "${DEB_STAGING}/usr/share/applications/"
cp -r "${STAGE_DIR}/share/icons/"* "${DEB_STAGING}/usr/share/icons/"
cp -r "${STAGE_DIR}/share/licenses/atlas/"* "${DEB_STAGING}/usr/share/licenses/tryatlas/"

# Debian policy's two files every binary package carries: the copyright
# statement (machine-readable format) and a compressed changelog.
cat <<EOF > "${DEB_STAGING}/usr/share/doc/tryatlas/copyright"
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Atlas
Upstream-Contact: Atlas Team <contact@tryatlas.cc>
Source: https://github.com/pacifio/atlas

Files: *
Copyright: Atlas contributors
License: Apache-2.0
 On Debian systems the full text of the Apache License 2.0 is in
 /usr/share/common-licenses/Apache-2.0. The licenses of bundled third-party
 code are in /usr/share/licenses/tryatlas.
EOF
printf 'tryatlas (%s) unstable; urgency=medium\n\n  * Atlas %s. Release notes: https://github.com/pacifio/atlas/releases/tag/%s\n\n -- Atlas Team <contact@tryatlas.cc>  %s\n' \
  "${VERSION}" "${VERSION}" "${RELEASE_TAG}" "$(date -R -u -d "@${SOURCE_DATE_EPOCH:-$(date +%s)}")" \
  | gzip -9n > "${DEB_STAGING}/usr/share/doc/tryatlas/changelog.Debian.gz"
chmod 644 "${DEB_STAGING}/usr/share/doc/tryatlas/"*
INSTALLED_SIZE="$(du -sk --apparent-size "${DEB_STAGING}/usr" | cut -f1)"
DEB_DEPENDS_LINE="$(join_by ", " "libc6 (>= ${GLIBC_NEEDED})" "${DEB_DEPENDS[@]}")"

cat <<EOF > "${DEB_STAGING}/DEBIAN/control"
Package: tryatlas
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${DEB_ARCH}
Maintainer: Atlas Team <contact@tryatlas.cc>
Installed-Size: ${INSTALLED_SIZE}
Depends: ${DEB_DEPENDS_LINE}
Suggests: wl-clipboard, xclip, xsel
Provides: tryatlas (= ${VERSION}), atl (= ${VERSION})
Description: Atlas — agent-first ideation and planning tool
 Atlas is an agent-first IDE and planning tool for software development.
EOF

# The maintainer scripts live in scripts/linux/deb/, shared with the
# cargo-deb path (scripts/linux/cargo-deb.sh), so the two debs behave the same.
cp "${ROOT_DIR}/scripts/linux/deb/postinst" "${DEB_STAGING}/DEBIAN/postinst"
cp "${ROOT_DIR}/scripts/linux/deb/postrm" "${DEB_STAGING}/DEBIAN/postrm"
chmod 755 "${DEB_STAGING}/DEBIAN/postinst" "${DEB_STAGING}/DEBIAN/postrm"

DEB_FILE="${OUTPUT_DIR}/tryatlas_${VERSION}_${DEB_ARCH}.deb"
if command -v dpkg-deb >/dev/null 2>&1; then
  # root:root ownership regardless of who builds, as lintian requires.
  dpkg-deb --root-owner-group --build "${DEB_STAGING}" "${DEB_FILE}"
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
# The shared-library requirements are read from the ELF by rpm itself, so
# they cannot drift from what the binary links. Provides stay off: the
# package provides commands, not the sonames inside it. bubblewrap is
# exec'd rather than linked, so it is named explicitly with the rest of
# runtime-deps.sh.
AutoReq:        yes
AutoProv:       no
Requires:       $(join_by ", " "${RPM_REQUIRES[@]}")
Suggests:       wl-clipboard, xclip, xsel

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
# The atlas command belongs to the standalone Atlas CLI; drop the alias earlier versions made
if [ -L /usr/bin/atlas ] && [ "\$(readlink /usr/bin/atlas)" = "atl" ]; then
  rm -f /usr/bin/atlas
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
/usr/share/applications/dev.atlas.ide.desktop
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
