# shellcheck shell=bash
# What Atlas needs at run time on Linux, in each package family's own names.
#
# The one list. package-linux.sh (deb, rpm) and aur-pkgbuild.sh (Arch) read
# it, so the three packages cannot disagree about what Atlas needs, which they
# did while each carried its own hand-typed copy. Sourced, not executed.
#
# Each row is one capability, so a row added to one family and not the others
# is visible in the diff:
#
#   capability     deb                           rpm                            arch
#   WebKitGTK 4.1  libwebkit2gtk-4.1-0           webkit2gtk4.1                  webkit2gtk-4.1
#   GTK 3          libgtk-3-0                    gtk3                           gtk3
#   tray icon      libayatana-appindicator3-1    libayatana-appindicator-gtk3   libayatana-appindicator
#   GLib           libglib2.0-0                  glib2                          (in gtk3)
#   TLS            (in libwebkit2gtk)            (in webkit2gtk4.1)             openssl
#   agent sandbox  bubblewrap                    bubblewrap                     bubblewrap
#
# bubblewrap is exec'd, not linked, so no library scan can find it: it must
# be named here or the native agent cannot run commands.

# shellcheck disable=SC2034 # read by the scripts that source this file
DEB_DEPENDS=(
  libwebkit2gtk-4.1-0
  libgtk-3-0
  libayatana-appindicator3-1
  libglib2.0-0
  bubblewrap
)
# Libraries the binary links that the deb does not name, because each is a
# hard dependency of a package in DEB_DEPENDS and apt installs it with that
# package. package-linux.sh runs dpkg-shlibdeps over the binary and fails on
# a linked library in neither list: that is a library apt would not install,
# and the app would fail at launch on a machine without it. A new one goes
# in DEB_DEPENDS if Atlas calls it, here if it only comes with something
# already named. Names are the pre-time64 ones; the check strips a `t64`
# suffix, since those packages Provide the old name.
# shellcheck disable=SC2034
DEB_LINKED_VIA_DEPENDS=(
  libc6
  libgcc-s1
  libstdc++6
  libcairo2
  libdbus-1-3
  libgdk-pixbuf-2.0-0
  libjavascriptcoregtk-4.1-0
  libsoup-3.0-0
)
# shellcheck disable=SC2034
RPM_REQUIRES=(
  webkit2gtk4.1
  gtk3
  libayatana-appindicator-gtk3
  glib2
  bubblewrap
)
# shellcheck disable=SC2034
ARCH_DEPENDS=(
  webkit2gtk-4.1
  gtk3
  libayatana-appindicator
  openssl
  bubblewrap
)
