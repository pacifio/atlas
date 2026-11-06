#!/usr/bin/env bash
# Set Atlas's version in every file that has to stay in sync.
#
# Usage:
#   ./scripts/bump.sh             # bumps the patch number: 0.1.2 -> 0.1.3
#   ./scripts/bump.sh 0.2.0       # sets the version explicitly (must be X.Y.Z)
#
# Touches:
#   - package.json                  ("version": "...")
#   - src-tauri/Cargo.toml          (version = "...")
#   - Cargo.lock                    (the atlas package's entry)
#   - src-tauri/tauri.conf.json     ("version": "...")
#
# Idempotent: every file is set to the new version whatever it held before. The
# release workflow relies on that — release-please has already moved
# package.json when `.github/workflows/release.yml` runs this on the release PR
# to bring the other three along. Portable (perl, not BSD or GNU sed), and needs
# no cargo, so it runs the same on a Mac and on a Linux runner.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/package.json"
CARGO="$ROOT/src-tauri/Cargo.toml"
LOCK="$ROOT/Cargo.lock"
TAURI_CONF="$ROOT/src-tauri/tauri.conf.json"

# Source of truth = package.json. Pull the first `"version": "..."` line.
current=$(grep -m1 '"version":' "$PKG" | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')
if [ -z "$current" ]; then
  echo "error: could not read current version from $PKG" >&2
  exit 1
fi

if [ "$#" -ge 1 ]; then
  new="$1"
  if ! echo "$new" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "error: '$new' is not a valid X.Y.Z version" >&2
    exit 1
  fi
else
  IFS='.' read -r major minor patch <<< "$current"
  if [ -z "${patch:-}" ] || ! echo "${major}${minor}${patch}" | grep -Eq '^[0-9]+$'; then
    echo "error: current version '$current' is not X.Y.Z" >&2
    exit 1
  fi
  new="$major.$minor.$((patch + 1))"
fi

echo "setting version to $new (package.json had $current)"

# JSON files: the first `"version": "…"` is the top-level one (no deps in
# tauri.conf.json; package.json's other version fields like `"packageManager"`
# aren't quoted this way). Only the first is replaced.
NEW="$new" perl -0pi -e 's/"version": "[^"]*"/"version": "$ENV{NEW}"/' "$PKG" "$TAURI_CONF"

# Cargo.toml: the `[package]` table's `version = "…"` is the only one at the
# start of a line (dependencies pin theirs inline), and it comes first.
NEW="$new" perl -0pi -e 's/^version = "[^"]*"/version = "$ENV{NEW}"/m' "$CARGO"

# Cargo.lock records the app's own version too. Left stale, every CI job's
# `cargo test --locked` refuses to run (one "v bump" commit failed 63 jobs).
# Only the `atlas` package's entry follows the app version.
NEW="$new" perl -0pi -e 's/(\[\[package\]\]\nname = "atlas"\nversion = )"[^"]*"/$1"$ENV{NEW}"/' "$LOCK"

for f in "$PKG" "$TAURI_CONF"; do
  got="$(grep -m1 '"version":' "$f" | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')"
  [ "$got" = "$new" ] || { echo "error: $f still says $got" >&2; exit 1; }
done
grep -m1 '^version = ' "$CARGO" | grep -qx "version = \"$new\"" || {
  echo "error: $CARGO was not updated" >&2
  exit 1
}
grep -A1 '^name = "atlas"$' "$LOCK" | grep -q "^version = \"$new\"$" || {
  echo "error: Cargo.lock's atlas entry was not updated" >&2
  exit 1
}

echo "done. updated:"
echo "  $PKG"
echo "  $CARGO"
echo "  $LOCK"
echo "  $TAURI_CONF"
