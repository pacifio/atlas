#!/usr/bin/env bash
# ============================================================================
# Atlas — verify a Linux release before it is published
#
# release-linux.yml used to publish whatever it built: the binary was located
# with `find` and never run, no package was ever installed, and a broken
# AppImage went out green. This script is the gate between "built" and
# "published", run by the release itself and by its pull-request dry run, so
# both answer the same question the same way.
#
# Usage:
#   scripts/verify-linux-release.sh <atlas binary> <artifacts dir>
#
# Environment:
#   GLIBC_FLOOR        highest GLIBC_x.y symbol version the binary may need
#                      (default 2.35, Ubuntu 22.04's: see release-linux.yml)
#   EXPECT_ARCH        x86_64 | aarch64 (default: this machine's)
#   VERIFY_GUI=1       also launch the AppImage under Xvfb and require it to
#                      stay up (needs xvfb-run)
#   VERIFY_INSTALL=1   also install the deb and rpm into clean distro
#                      containers and run them there (needs docker)
#   VERIFY_LINT=report|fail
#                      run lintian / rpmlint / namcap when present; `report`
#                      prints findings, `fail` fails on errors (default report)
#
# Every check prints PASS / FAIL / SKIP on one line; the script exits non-zero
# if any check failed, after running all of them, so one CI log shows every
# problem at once.
# ============================================================================

set -uo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <atlas binary> <artifacts dir>" >&2
  exit 2
fi

BIN="$(realpath "$1")"
ART="$(realpath "$2")"
GLIBC_FLOOR="${GLIBC_FLOOR:-2.35}"
EXPECT_ARCH="${EXPECT_ARCH:-$(uname -m)}"
VERIFY_LINT="${VERIFY_LINT:-report}"

case "$EXPECT_ARCH" in
  x86_64) ELF_MACHINE="x86-64" ;;
  aarch64) ELF_MACHINE="ARM aarch64" ;;
  *)
    echo "EXPECT_ARCH must be x86_64 or aarch64, got ${EXPECT_ARCH}" >&2
    exit 2
    ;;
esac

FAILED=0
pass() { echo "PASS  $1"; }
fail() {
  echo "FAIL  $1"
  [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'
  FAILED=1
}
skip() { echo "SKIP  $1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The one artifact of each kind, or empty. More than one is itself a failure:
# the release would publish both and the AUR/checksum steps would pick one.
one() {
  local matches
  mapfile -t matches < <(find "$ART" -maxdepth 1 -type f -name "$1" | sort)
  if [ "${#matches[@]}" -gt 1 ]; then
    echo "AMBIGUOUS"
  elif [ "${#matches[@]}" -eq 1 ]; then
    echo "${matches[0]}"
  fi
}

# A binary that loads and reaches `main` without starting the GUI: the
# `mcp-bridge` entrypoint with no arguments prints its usage and exits 2
# (`run_bridge_if_asked` in src-tauri/src/lib.rs). Anything else — a missing
# shared library, a too-new glibc, a crash in static init — exits otherwise.
probe() {
  local out code
  out="$("$@" mcp-bridge 2>&1 </dev/null)"
  code=$?
  if [ "$code" -eq 2 ] && grep -q "usage: atlas mcp-bridge" <<<"$out"; then
    return 0
  fi
  printf 'exit %s\n%s\n' "$code" "$out"
  return 1
}

# Highest x.y in a list of versions.
max_version() { sort -V | tail -n 1; }

echo "== Atlas Linux release verification =="
echo "binary:     $BIN"
echo "artifacts:  $ART"
echo "arch:       $EXPECT_ARCH    glibc floor: $GLIBC_FLOOR"
echo

# --- 1. the binary itself ----------------------------------------------------

if [ ! -x "$BIN" ]; then
  fail "binary exists and is executable" "$BIN"
else
  pass "binary exists and is executable"

  desc="$(file -b "$BIN")"
  if grep -q "ELF 64-bit" <<<"$desc" && grep -q "$ELF_MACHINE" <<<"$desc"; then
    pass "binary is a 64-bit ELF for $EXPECT_ARCH"
  else
    fail "binary is a 64-bit ELF for $EXPECT_ARCH" "$desc"
  fi

  missing="$(ldd "$BIN" 2>&1 | grep 'not found' || true)"
  if [ -z "$missing" ]; then
    pass "every shared library resolves (ldd)"
  else
    fail "every shared library resolves (ldd)" "$missing"
  fi

  needed="$(objdump -T "$BIN" 2>/dev/null | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | max_version)"
  if [ -z "$needed" ]; then
    fail "glibc requirement readable" "objdump -T found no GLIBC_ versions"
  elif [ "$(printf '%s\n%s\n' "$needed" "$GLIBC_FLOOR" | max_version)" = "$GLIBC_FLOOR" ]; then
    pass "needs glibc $needed, within the $GLIBC_FLOOR floor"
  else
    fail "needs glibc $needed, within the $GLIBC_FLOOR floor" \
      "a distro older than glibc $needed cannot load this binary; build on an older base"
  fi

  if err="$(probe "$BIN")"; then
    pass "binary starts and reaches main (mcp-bridge usage probe)"
  else
    fail "binary starts and reaches main (mcp-bridge usage probe)" "$err"
  fi
fi

# --- 2. the artifact set -----------------------------------------------------

TARBALL="$(one "atlas-*-linux-${EXPECT_ARCH}.tar.gz")"
case "$EXPECT_ARCH" in
  x86_64) DEB="$(one "tryatlas_*_amd64.deb")" ;;
  aarch64) DEB="$(one "tryatlas_*_arm64.deb")" ;;
esac
RPM="$(one "tryatlas-*.${EXPECT_ARCH}.rpm")"
APPIMAGE="$(one "*.AppImage")"
ARCHPKG="$(one "tryatlas-bin-*-${EXPECT_ARCH}.pkg.tar.zst")"

for pair in "tarball:$TARBALL" "deb:$DEB" "rpm:$RPM" "AppImage:$APPIMAGE" "Arch package:$ARCHPKG"; do
  name="${pair%%:*}"
  path="${pair#*:}"
  if [ "$path" = "AMBIGUOUS" ]; then
    fail "exactly one $name" "more than one matched in $ART"
  elif [ -n "$path" ]; then
    pass "$name present: $(basename "$path")"
  else
    fail "$name present" "none in $ART"
  fi
done
[ "$TARBALL" = "AMBIGUOUS" ] && TARBALL=""
[ "$DEB" = "AMBIGUOUS" ] && DEB=""
[ "$RPM" = "AMBIGUOUS" ] && RPM=""
[ "$APPIMAGE" = "AMBIGUOUS" ] && APPIMAGE=""
[ "$ARCHPKG" = "AMBIGUOUS" ] && ARCHPKG=""

if [ -f "$ART/SHA256SUMS.txt" ]; then
  if out="$(cd "$ART" && sha256sum --strict -c SHA256SUMS.txt 2>&1)"; then
    pass "SHA256SUMS.txt matches every artifact"
  else
    fail "SHA256SUMS.txt matches every artifact" "$out"
  fi
else
  skip "SHA256SUMS.txt (not written yet)"
fi

# --- 3. what is inside each package -------------------------------------------

if [ -n "$TARBALL" ]; then
  listing="$(tar -tzf "$TARBALL")"
  bad=""
  for want in bin/atlas bin/atl bin/tryatlas install.sh uninstall.sh \
    share/applications/dev.atlas.ide.desktop share/icons/hicolor/512x512/apps/atlas.png; do
    grep -q "^atlas-[^/]*/${want}$" <<<"$listing" || bad+="missing ${want}"$'\n'
  done
  if [ -z "$bad" ]; then
    pass "tarball carries the binary, links, desktop entry, icons and installers"
  else
    fail "tarball carries the binary, links, desktop entry, icons and installers" "$bad"
  fi

  mkdir -p "$WORK/tar"
  tar -xzf "$TARBALL" -C "$WORK/tar"
  if err="$(probe "$WORK"/tar/atlas-*/bin/atlas)"; then
    pass "tarball's binary starts"
  else
    fail "tarball's binary starts" "$err"
  fi
fi

if [ -n "$DEB" ]; then
  info="$(dpkg-deb --info "$DEB")"
  contents="$(dpkg-deb -c "$DEB")"
  bad=""
  grep -q '^ Package: tryatlas$' <<<"$info" || bad+="Package is not tryatlas"$'\n'
  grep -q '^ Depends: .*bubblewrap' <<<"$info" || bad+="Depends lacks bubblewrap"$'\n'
  grep -q '\./usr/bin/atl$' <<<"$contents" || bad+="no /usr/bin/atl"$'\n'
  grep -q '\./usr/bin/atlas$' <<<"$contents" && bad+="claims /usr/bin/atlas (the Atlas CLI's name)"$'\n'
  if [ -z "$bad" ]; then
    pass "deb metadata and payload"
  else
    fail "deb metadata and payload" "$bad"
  fi
fi

if [ -n "$RPM" ]; then
  if command -v rpm >/dev/null 2>&1; then
    files="$(rpm -qpl "$RPM" 2>/dev/null)"
    reqs="$(rpm -qpR "$RPM" 2>/dev/null)"
    bad=""
    grep -qx '/usr/bin/atl' <<<"$files" || bad+="no /usr/bin/atl"$'\n'
    grep -qx '/usr/bin/atlas' <<<"$files" && bad+="claims /usr/bin/atlas (the Atlas CLI's name)"$'\n'
    grep -q 'bubblewrap' <<<"$reqs" || bad+="Requires lacks bubblewrap"$'\n'
    if [ -z "$bad" ]; then
      pass "rpm metadata and payload"
    else
      fail "rpm metadata and payload" "$bad"
    fi
  else
    skip "rpm metadata and payload (no rpm tool)"
  fi
fi

if [ -n "$APPIMAGE" ]; then
  chmod +x "$APPIMAGE"
  # Extract-and-run needs no FUSE, which CI runners and many containers lack.
  if err="$(APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 probe "$APPIMAGE")"; then
    pass "AppImage starts and reaches main"
  else
    fail "AppImage starts and reaches main" "$err"
  fi
fi

# --- 4. the GUI actually comes up ---------------------------------------------

if [ "${VERIFY_GUI:-0}" = "1" ] && [ -n "$APPIMAGE" ]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    log="$WORK/gui.log"
    # A fresh HOME, so a developer's real profile is never touched and a
    # first launch is what is tested.
    mkdir -p "$WORK/home"
    HOME="$WORK/home" APPIMAGE_EXTRACT_AND_RUN=1 \
      xvfb-run -a -s "-screen 0 1280x800x24" "$APPIMAGE" >"$log" 2>&1 &
    pid=$!
    sleep 20
    if kill -0 "$pid" 2>/dev/null; then
      pass "AppImage GUI is still running after 20 s under Xvfb"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    else
      wait "$pid"
      fail "AppImage GUI is still running after 20 s under Xvfb" "exit $?; last log lines:
$(tail -n 40 "$log")"
    fi
  else
    fail "AppImage GUI under Xvfb" "VERIFY_GUI=1 but xvfb-run is not installed"
  fi
else
  skip "AppImage GUI under Xvfb (set VERIFY_GUI=1)"
fi

# --- 5. the packages install on clean distros ---------------------------------

# Each package installed with the distro's own resolver, which is the only
# check that proves the hand-typed Depends/Requires lines name real packages,
# then run, then removed. The image list is the support matrix's floor and a
# current release of each family (docs/reference/linux-support.md).
install_check() {
  local image="$1" pkg="$2" install="$3" remove="$4"
  local name out
  name="$(basename "$pkg")"
  if out="$(docker run --rm -v "$pkg:/tmp/$name:ro" "$image" bash -c "
      set -e
      $install /tmp/$name >/dev/null
      out=\$(atl mcp-bridge 2>&1 </dev/null) && code=0 || code=\$?
      [ \"\$code\" -eq 2 ] && grep -q 'usage: atlas mcp-bridge' <<<\"\$out\" || { echo \"exit \$code: \$out\"; exit 1; }
      test -L /usr/bin/tryatlas
      test -f /usr/share/applications/dev.atlas.ide.desktop
      $remove >/dev/null
      test ! -e /usr/bin/atl
    " 2>&1)"; then
    pass "$name installs, runs and removes on $image"
  else
    fail "$name installs, runs and removes on $image" "$(tail -n 30 <<<"$out")"
  fi
}

if [ "${VERIFY_INSTALL:-0}" = "1" ]; then
  if command -v docker >/dev/null 2>&1; then
    if [ -n "$DEB" ]; then
      for image in ubuntu:22.04 debian:12 ubuntu:24.04; do
        install_check "$image" "$DEB" \
          "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq" \
          "apt-get remove -y -qq tryatlas"
      done
    fi
    if [ -n "$RPM" ]; then
      install_check "fedora:latest" "$RPM" "dnf install -y -q" "dnf remove -y -q tryatlas"
    fi
    if [ -n "$ARCHPKG" ] && [ "$EXPECT_ARCH" = "x86_64" ]; then
      # Arch Linux ARM has no official image; the x86-64 package is the one
      # the AUR builds from.
      install_check "archlinux:latest" "$ARCHPKG" \
        "pacman -Syu --noconfirm >/dev/null && pacman -U --noconfirm" \
        "pacman -R --noconfirm tryatlas-bin"
    fi
  else
    fail "package installs on clean distros" "VERIFY_INSTALL=1 but docker is not installed"
  fi
else
  skip "package installs on clean distros (set VERIFY_INSTALL=1)"
fi

# --- 6. distro linters ---------------------------------------------------------

lint() {
  local label="$1"
  shift
  local out code
  out="$("$@" 2>&1)"
  code=$?
  if [ "$code" -eq 0 ]; then
    pass "$label"
  elif [ "$VERIFY_LINT" = "fail" ]; then
    fail "$label" "$out"
  else
    echo "WARN  $label (report only)"
    printf '%s\n' "$out" | sed 's/^/      /'
  fi
}

if [ -n "$DEB" ] && command -v lintian >/dev/null 2>&1; then
  lint "lintian" lintian --fail-on error "$DEB"
else
  skip "lintian (not installed or no deb)"
fi
if [ -n "$RPM" ] && command -v rpmlint >/dev/null 2>&1; then
  lint "rpmlint" rpmlint "$RPM"
else
  skip "rpmlint (not installed or no rpm)"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Linux release verification FAILED"
  exit 1
fi
echo "Linux release verification passed"
