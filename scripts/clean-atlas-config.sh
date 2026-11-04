#!/usr/bin/env bash
# Wipe all local Atlas app data for a true first-run (macOS).
# Removes ~/.config/atlas (config.toml), app support, caches, WebKit state,
# and preferences for the bundle id (dev.atlas.ide). Does NOT touch the repo,
# build artifacts, or any agent CLI credentials (~/.claude etc).
#
# `--dev` (`bun run clean:app:dev`) wipes Atlas Dev's instead — the profile
# `bun run dev:app` runs under (dev.atlas.ide.dev, ~/.config/atlas-dev) — and
# leaves the installed Atlas's data alone. Without it, this wipes the
# installed Atlas's data, never Atlas Dev's.
#
# Settings › Privacy › Local data ("Reset Atlas", "Clear cache") does the same
# from inside the app: `targets` in src-tauri/src/commands/app_data_reset.rs
# names these directories too. Change the two lists together.
#
# `bun run dev:app` runs unbundled, so WebKit names its Caches, WebKit and
# Preferences entries after the binary, `atlas`, not after a bundle id. Those
# are Atlas Dev's: `--dev` removes them and the default leaves them alone.
set -euo pipefail

dev=0
if [ "${1:-}" = "--dev" ]; then
  dev=1
elif [ $# -gt 0 ]; then
  echo "usage: $0 [--dev]" >&2
  exit 2
fi

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
if [ "$dev" -eq 1 ]; then
  # A source build's binary, not the installed app's.
  if pgrep -f 'target/(debug|release)/atlas$' >/dev/null 2>&1; then
    echo "error: Atlas Dev is running — quit it first" >&2
    exit 1
  fi
  ids=(dev.atlas.ide.dev atlas)
  dirs=(
    "$config_home/atlas-dev"
    "$HOME/Library/Application Support/dev.atlas.ide.dev"
    "$HOME/Library/Caches/dev.atlas.ide.dev"
    "$HOME/Library/Caches/atlas"
    "$HOME/Library/WebKit/dev.atlas.ide.dev"
    "$HOME/Library/WebKit/atlas"
  )
  leftover_pattern="*dev.atlas.ide.dev*"
  label="Atlas Dev"
else
  if pgrep -x atlas >/dev/null 2>&1; then
    echo "error: atlas is running — quit it first" >&2
    exit 1
  fi
  ids=(dev.atlas.ide)
  dirs=(
    "$config_home/atlas"
    "$HOME/Library/Application Support/dev.atlas.ide"
    "$HOME/Library/Caches/dev.atlas.ide"
    "$HOME/Library/WebKit/dev.atlas.ide"
  )
  leftover_pattern="*atlas*"
  label="atlas"
fi

removed=0
for d in "${dirs[@]}"; do
  if [ -e "$d" ]; then
    du -sh "$d"
    rm -rf "$d"
    removed=1
  fi
done

for p in "${ids[@]}"; do
  # `defaults delete` flushes cfprefsd's cache so the plist doesn't resurrect.
  defaults delete "$p" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/Preferences/$p.plist"
done

# The other profile's data is not a leftover.
leftover=$(find "$HOME/Library" -maxdepth 2 -iname "$leftover_pattern" 2>/dev/null |
  grep -iv claude | {
  if [ "$dev" -eq 1 ]; then
    cat
  else
    grep -Ev 'dev\.atlas\.ide\.dev|/(Caches|WebKit)/atlas$|/Preferences/atlas\.plist$'
  fi
} || true)
if [ -n "$leftover" ]; then
  echo "warning: leftovers found:" >&2
  echo "$leftover" >&2
  exit 1
fi

[ "$removed" -eq 1 ] && echo "$label app data wiped — next launch is a first-run" || echo "already clean"
