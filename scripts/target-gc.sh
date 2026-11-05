#!/usr/bin/env bash
# Garbage-collects a cargo target dir. Stable cargo never deletes anything from
# one: `-Z gc` is nightly-only and covers ~/.cargo, not target/. Left alone,
# target/debug reached 67 GB, more than half of it unusable.
#
#   scripts/target-gc.sh <target-dir>
#
# `ci:local` runs it before its jobs, on this machine's target dir and in the
# Linux container on the cache volume's, so the policy is the same for both.
# Two kinds of garbage, each with its own trigger:
#
#   1. A Rust upgrade. Nothing the old compiler built can be reused, and after
#      the 1.98 -> 1.99 bump that was 41 GB of artifacts plus 17 GB of
#      incremental state. `cargo sweep --toolchains` removes exactly what the
#      pinned toolchain did not build. Not a wipe: `dev:app` may already have
#      rebuilt everything with the new compiler before this runs. Only an
#      upgrade triggers it: a worktree on an older version branch can share
#      this target dir, and alternating with it must not throw builds away.
#   2. Dependency bumps, which leave the old version's artifacts behind for
#      good. Once a week, `cargo sweep --time 30` removes what cargo has not
#      read in 30 days. Cargo reads a crate's fingerprint every time it checks
#      the crate is fresh, so its access time is a real "last used". The cost
#      of a wrong call is a rebuild, never a broken build.
#   3. Size, only when ATLAS_GC_MAX_MB is set. A target dir shared by many
#      worktrees churns through dependency bumps faster than a 30-day window
#      can age them out, so over the cap `cargo sweep --maxsize` removes the
#      least recently used artifacts until it fits. Unset, nothing is capped.
#
#      cargo-sweep counts incremental state toward the size but never removes
#      it, so over the cap that goes first.
#
# ATLAS_GC_UNUSED_DAYS and ATLAS_GC_EVERY_DAYS override the 30 and 7 above;
# the agent worktrees' shared target dir sets all three, the main checkout none.
#
# A target/ that is a symlink is that shared dir, and other worktrees may be
# building in it. cargo-sweep takes no build lock, so a sweep there could
# delete artifacts out from under a running build. The worktree wrapper
# collects it while holding its build lock and says so with ATLAS_GC_LOCKED=1;
# called any other way (`ci:local` in a worktree), this leaves it alone.
#
# cargo-sweep leaves `incremental/` alone (its directories have no
# fingerprint), so this removes it on an upgrade and ages it out by mtime,
# which a compile of the crate refreshes. Incremental state only ever saves
# time, so losing it costs one non-incremental compile of a workspace member.
#
# Needs cargo-sweep (`cargo install cargo-sweep`). Without it, the upgrade
# still clears incremental state and the rest prints the install hint once.
set -euo pipefail

UNUSED_DAYS=${ATLAS_GC_UNUSED_DAYS:-30}
SWEEP_EVERY_DAYS=${ATLAS_GC_EVERY_DAYS:-7}
MAX_MB=${ATLAS_GC_MAX_MB:-}

target=${1:?usage: target-gc.sh <target-dir>}
[ -d "$target" ] || exit 0
if [ -L "$target" ] && [ -z "${ATLAS_GC_LOCKED:-}" ]; then
  echo "target-gc: $target is a shared target dir; the worktree wrapper collects it"
  exit 0
fi
# The repo root, so rustup resolves the toolchain rust-toolchain.toml pins.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

release=$(rustc -vV | sed -n 's/^release: //p')
toolchain=$(rustup show active-toolchain | cut -d' ' -f1)
stamp="$target/.atlas-gc-rustc"
swept="$target/.atlas-gc-swept"
have_sweep=false
command -v cargo-sweep >/dev/null 2>&1 && have_sweep=true

say() { echo "target-gc: $*"; }
# Never fatal (a failed collection must not fail the run), never silent.
sweep() {
  local out
  if out=$(CARGO_TARGET_DIR="$target" cargo sweep "$@" . 2>&1); then
    grep -E '^\[INFO\] Cleaned' <<<"$out" || true
  else
    say "cargo sweep $* failed:"
    tail -5 <<<"$out"
  fi
}
incremental_dirs() { find "$target" -mindepth 2 -maxdepth 3 -type d -name incremental; }

if [ ! -f "$stamp" ]; then
  echo "$release" >"$stamp"
else
  last=$(cat "$stamp")
  newest=$(printf '%s\n%s\n' "$last" "$release" | sort -V | tail -1)
  if [ "$last" != "$release" ] && [ "$newest" = "$release" ]; then
    say "Rust $last -> $release: removing what $last built"
    incremental_dirs | while read -r d; do rm -rf "$d"; done
    if $have_sweep; then
      sweep --toolchains "$toolchain"
    else
      say "install cargo-sweep (\`cargo install cargo-sweep\`) to remove the rest; see CONTRIBUTING"
    fi
    echo "$release" >"$stamp"
  fi
fi

if $have_sweep && { [ ! -f "$swept" ] || [ -n "$(find "$swept" -mtime +"$SWEEP_EVERY_DAYS")" ]; }; then
  say "removing artifacts unused for $UNUSED_DAYS days"
  sweep --time "$UNUSED_DAYS"
  incremental_dirs | while read -r d; do
    find "$d" -mindepth 1 -maxdepth 1 -type d -mtime +"$UNUSED_DAYS" -exec rm -rf {} +
  done
  touch "$swept"
fi

# The trailing slash makes du measure the directory a symlink points at.
size_mb() { echo $(( $(du -sk "$target/" | cut -f1) / 1024 )); }
if $have_sweep && [ -n "$MAX_MB" ] && [ "$(size_mb)" -gt "$MAX_MB" ]; then
  say "$(size_mb) MB is over the ${MAX_MB} MB cap: removing incremental state and the least recently used artifacts"
  incremental_dirs | while read -r d; do rm -rf "$d"; done
  sweep --maxsize "$MAX_MB"
  # cargo-sweep keeps an artifact bigger than what is left to remove, so it
  # can stop short. Say so rather than escalate to a wipe.
  if [ "$(size_mb)" -gt "$MAX_MB" ]; then
    say "still $(size_mb) MB after the sweep; rm -rf $target/ to start over"
  fi
fi
