#!/usr/bin/env bash
# Wipe all local Atlas app data for a true first-run (macOS).
# Removes ~/.config/atlas (config.toml), app support, caches, WebKit state,
# and preferences for both the current bundle id (dev.atlas.ide) and the
# legacy `atlas` name. Does NOT
# touch the repo, build artifacts, or any agent CLI credentials (~/.claude etc).
set -euo pipefail

if pgrep -x atlas >/dev/null 2>&1; then
  echo "error: atlas is running — quit it first" >&2
  exit 1
fi

removed=0
for d in \
  "${XDG_CONFIG_HOME:-$HOME/.config}/atlas" \
  "$HOME/Library/Application Support/dev.atlas.ide" \
  "$HOME/Library/Caches/atlas" \
  "$HOME/Library/Caches/dev.atlas.ide" \
  "$HOME/Library/WebKit/atlas" \
  "$HOME/Library/WebKit/dev.atlas.ide"; do
  if [ -e "$d" ]; then
    du -sh "$d"
    rm -rf "$d"
    removed=1
  fi
done

for p in atlas dev.atlas.ide; do
  # `defaults delete` flushes cfprefsd's cache so the plist doesn't resurrect.
  defaults delete "$p" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/Preferences/$p.plist"
done

leftover=$(find "$HOME/Library" -maxdepth 2 -iname "*atlas*" 2>/dev/null | grep -iv claude || true)
if [ -n "$leftover" ]; then
  echo "warning: leftovers found:" >&2
  echo "$leftover" >&2
  exit 1
fi

[ "$removed" -eq 1 ] && echo "atlas app data wiped — next launch is a first-run" || echo "already clean"
