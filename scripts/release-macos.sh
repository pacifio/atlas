#!/usr/bin/env bash
# ============================================================================
# Atlas — signed + notarized macOS release build
# ============================================================================
#
# What this does, in order:
#   1.  Sanity-check the Developer ID cert is in the login keychain.
#   2.  Sanity-check the notarization credentials are in the env.
#   3.  Clean the target dir so old artifacts don't leak into the bundle.
#   4.  Build for the requested arch via `bun run tauri build`.
#       Tauri picks up the env vars below and:
#         - codesigns the .app with --options=runtime + entitlements.plist
#         - bundles a .dmg
#         - submits the .dmg to Apple's notary service
#         - staples the ticket back onto the .dmg
#   5.  Verify the signature + Gatekeeper acceptance on the final artifact.
#   6.  Print where the shippable .dmg lives.
#
# One-time setup (do these once on your build machine, not in CI):
#
#   a) Verify your Developer ID cert is in the login keychain:
#        security find-identity -v -p codesigning
#      You should see "Developer ID Application: <name> (PLKDA3WBJJ)".
#
#   b) Generate an app-specific password for notarization:
#        - Visit appleid.apple.com → Sign-In and Security → App-Specific Passwords
#        - Label it "Atlas notarization", copy the value
#
#   c) Export the three notarization env vars (add to ~/.zshrc or ~/.bashrc):
#        export APPLE_ID="you@example.com"
#        export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password
#        export APPLE_TEAM_ID="PLKDA3WBJJ"             # the 10-char team id
#
#   Alternative for CI: use an App Store Connect API key instead of password
#   by setting APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER.
#
# Usage:
#   ./scripts/release-macos.sh                                 # TWO dmgs: arm64 + Intel (the default)
#   TARGET=aarch64-apple-darwin ./scripts/release-macos.sh     # Apple Silicon only
#   TARGET=x86_64-apple-darwin ./scripts/release-macos.sh      # Intel only
#   UNIVERSAL=1 ./scripts/release-macos.sh                     # ONE fat dmg (arm64 + x86_64), slow
#   SKIP_NOTARIZE=1 ./scripts/release-macos.sh                 # skip Apple round-trip (dev only)
#
# Two dmgs vs UNIVERSAL — different products, not two routes to the same one:
#   default     two separate downloads, each ~half the size. Each is built,
#               signed, notarized and stapled by Tauri's own path.
#   UNIVERSAL=1 one download that runs anywhere, roughly twice the size, built by
#               lipo'ing two .apps together and re-signing by hand.
# Ship the two unless you specifically want a single universal download.
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")/.."  # cd to repo root

# ── Config ──────────────────────────────────────────────────────────────────
# Developer ID identity. Override at the command line if you ever rotate certs.
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Adib Mohsin (PLKDA3WBJJ)}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-PLKDA3WBJJ}"

UNIVERSAL="${UNIVERSAL:-0}"

# The architectures this run produces a dmg for.
#
# A release ships BOTH by default: an arm64-only dmg silently excludes every
# Intel Mac, and the failure mode is a user downloading something that will not
# launch. Narrowing to one arch is the opt-in, via TARGET.
if [[ -n "${TARGET:-}" ]]; then
  TARGETS=("${TARGET}")
else
  TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)
fi

# Set to 1 to skip the notarization round-trip (build still signs locally).
# Useful while iterating on the build itself; the resulting .app/.dmg will
# fail Gatekeeper unless `xattr -dr com.apple.quarantine` is applied.
SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"

# ── Pretty output ───────────────────────────────────────────────────────────
log() { printf "\033[1;34m[release]\033[0m %s\n" "$*"; }
ok()  { printf "\033[1;32m[ok]\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m[err]\033[0m %s\n" "$*" >&2; }

# ── 1. Cert sanity check ────────────────────────────────────────────────────
log "Looking up codesigning identity"
if ! security find-identity -v -p codesigning | grep -q "${APPLE_TEAM_ID}"; then
  err "Developer ID Application cert for team ${APPLE_TEAM_ID} not found."
  err "Run \`security find-identity -v -p codesigning\` and check the output."
  exit 1
fi
ok "Found ${APPLE_SIGNING_IDENTITY}"

# ── 2. Notarization credentials ─────────────────────────────────────────────
if [[ "${SKIP_NOTARIZE}" != "1" ]]; then
  : "${APPLE_ID:?APPLE_ID is not set — see header comment for one-time setup}"
  : "${APPLE_PASSWORD:?APPLE_PASSWORD (app-specific password) is not set}"
  ok "Notarization credentials present for ${APPLE_ID}"
else
  log "SKIP_NOTARIZE=1 — local sign only, no Apple notary round-trip"
fi

# ── 3. Make sure the Rust target is installed ───────────────────────────────
ensure_target() {
  local t="$1"
  if ! rustup target list --installed | grep -qx "${t}"; then
    log "Installing missing rust target ${t}"
    rustup target add "${t}"
  fi
}

if [[ "${UNIVERSAL}" == "1" ]]; then
  ensure_target aarch64-apple-darwin
  ensure_target x86_64-apple-darwin
else
  for t in "${TARGETS[@]}"; do ensure_target "${t}"; done
fi

# The C-building dependencies need an SDK path. The macOS SDK is universal, so
# one root serves both architectures — what matters is that it is SET, which it
# is not in a login shell that never sourced a dev profile.
export SDKROOT="${SDKROOT:-$(xcrun --show-sdk-path)}"

# ── 4. Export env for tauri-cli ─────────────────────────────────────────────
# Tauri reads these env vars and threads them through codesign + notarytool.
export APPLE_SIGNING_IDENTITY
export APPLE_TEAM_ID
[[ "${SKIP_NOTARIZE}" != "1" ]] && export APPLE_ID APPLE_PASSWORD

# ── 4b. Bake the PostHog telemetry key (mirrors scripts/with-posthog-env.mjs) ─
# CRITICAL: this script calls `tauri build` DIRECTLY, not through that Node
# wrapper — so without loading `.env` here, `option_env!("ATLAS_POSTHOG_KEY")`
# in src-tauri/telemetry resolves to None and the released app ships with
# telemetry INERT (this is why PostHog "works in dev but not production": dev
# goes through the wrapper). `build.rs` already declares rerun-if-env-changed,
# so setting these forces a recompile that bakes the key in. Real env always
# wins over `.env`; a missing/blank key just leaves telemetry disabled.
load_env_key() {
  local name="$1"
  # NOTE: every early-exit uses `return 0`. A bare `return` after a failed test
  # (`[[ … ]] || return`) propagates that test's non-zero status, and under
  # `set -e` a top-level call to a function returning non-zero aborts the whole
  # script — which silently killed the release right after the notarize check.
  [[ -n "${!name:-}" ]] && return 0   # real env wins
  [[ -f .env ]] || return 0
  local line val
  line="$(grep -E "^[[:space:]]*${name}[[:space:]]*=" .env | tail -n1 || true)"
  [[ -n "${line}" ]] || return 0
  val="${line#*=}"
  # trim surrounding whitespace, then surrounding quotes
  val="$(printf '%s' "${val}" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^["'\'']//; s/["'\'']$//')"
  export "${name}=${val}"
}
load_env_key ATLAS_POSTHOG_KEY
load_env_key ATLAS_POSTHOG_HOST
load_env_key POSTHOG_KEY
load_env_key POSTHOG_HOST
# Accept POSTHOG_* as aliases for the build-time ATLAS_* names.
[[ -z "${ATLAS_POSTHOG_KEY:-}"  && -n "${POSTHOG_KEY:-}"  ]] && export ATLAS_POSTHOG_KEY="${POSTHOG_KEY}"
[[ -z "${ATLAS_POSTHOG_HOST:-}" && -n "${POSTHOG_HOST:-}" ]] && export ATLAS_POSTHOG_HOST="${POSTHOG_HOST}"
if [[ -n "${ATLAS_POSTHOG_KEY:-}" ]]; then
  ok "PostHog telemetry key embedded for this release"
else
  log "PostHog key not set (.env missing key) — telemetry will be INERT in this build"
fi

# ── 6/7. Verify each artifact — signature, Gatekeeper, stapled ticket ───────
# Defined here but CALLED from build_signed_dmg above, so with BOTH=1 each
# architecture is verified as it finishes instead of both at the end. A failure
# then names the arch that produced it, and does not burn a second full build
# first.
verify_artifacts() {
  local app_path="$1" dmg_path="$2"

  if [[ ! -d "${app_path}" ]]; then
    err ".app not found at ${app_path}"
    exit 1
  fi
  if [[ -z "${dmg_path}" || ! -f "${dmg_path}" ]]; then
    err "No .dmg produced"
    exit 1
  fi
  ok "Built ${app_path}"
  ok "Built ${dmg_path}"

  log "Verifying codesign on the .app"
  codesign --verify --deep --strict --verbose=2 "${app_path}"
  ok "Signature valid"

  if [[ "${SKIP_NOTARIZE}" != "1" ]]; then
    log "Verifying Gatekeeper acceptance"
    if spctl --assess --type execute --verbose "${app_path}"; then
      ok "Gatekeeper accepts the .app"
    else
      err "Gatekeeper rejected the .app — notarization probably failed"
      err "Check the build log above for the notarytool submission ID + log URL"
      exit 1
    fi

    log "Verifying the .dmg has a stapled ticket"
    if xcrun stapler validate "${dmg_path}"; then
      ok "Stapled ticket on .dmg"
    else
      err "Stapler validation failed on ${dmg_path}"
      exit 1
    fi
  fi
}

# ── 5. Build ────────────────────────────────────────────────────────────────
# Collected across every architecture this run builds, so the summary and the
# universal branch read the same list.
DMG_PATHS=()
APP_PATHS=()

if [[ "${UNIVERSAL}" == "1" ]]; then
  # Manual universal build: two single-arch builds + lipo. Avoids the
  # `--target universal-apple-darwin` codepath which has had issues in
  # @tauri-apps/cli 2.10.x where cargo's metadata pass sees the synthetic
  # target before tauri intercepts.
  log "Universal build — arm64 first"
  rm -rf "src-tauri/target/aarch64-apple-darwin/release/bundle"
  bun run tauri build --target aarch64-apple-darwin

  log "Universal build — x86_64 next"
  rm -rf "src-tauri/target/x86_64-apple-darwin/release/bundle"
  bun run tauri build --target x86_64-apple-darwin

  log "lipo'ing into a fat .app"
  ARM_APP="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Atlas.app"
  INTEL_APP="src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Atlas.app"
  UNI_DIR="src-tauri/target/universal-apple-darwin/release/bundle/macos"
  mkdir -p "${UNI_DIR}"
  rm -rf "${UNI_DIR}/Atlas.app"
  cp -R "${ARM_APP}" "${UNI_DIR}/Atlas.app"
  lipo \
    -create \
    -output "${UNI_DIR}/Atlas.app/Contents/MacOS/Atlas" \
    "${ARM_APP}/Contents/MacOS/Atlas" \
    "${INTEL_APP}/Contents/MacOS/Atlas"

  # Re-sign the fat binary — lipo invalidates the original signature.
  log "Re-signing the fat .app"
  codesign --force --deep --options=runtime \
    --entitlements src-tauri/entitlements.plist \
    --sign "${APPLE_SIGNING_IDENTITY}" \
    "${UNI_DIR}/Atlas.app"

  # Re-bundle a DMG against the lipo'd .app. We use `create-dmg` if it's
  # installed, otherwise hdiutil. Tauri's DMG packager won't re-run on a
  # bundle we lipo'd by hand.
  UNI_DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
  mkdir -p "${UNI_DMG_DIR}"
  DMG_OUT="${UNI_DMG_DIR}/Atlas_universal.dmg"
  rm -f "${DMG_OUT}"
  log "Building DMG at ${DMG_OUT}"
  hdiutil create -volname "Atlas" -srcfolder "${UNI_DIR}/Atlas.app" -ov -format UDZO "${DMG_OUT}" >/dev/null
  bash "$(dirname "$0")/set-dmg-icon.sh" src-tauri/icons/icon.icns "${DMG_OUT}"
  codesign --force --sign "${APPLE_SIGNING_IDENTITY}" "${DMG_OUT}"

  # Notarize the DMG via xcrun notarytool (Tauri's automated notarization
  # only fires on its built-in build path, not our hand-lipo'd one).
  if [[ "${SKIP_NOTARIZE}" != "1" ]]; then
    log "Submitting universal DMG for notarization (this can take minutes)"
    xcrun notarytool submit "${DMG_OUT}" \
      --apple-id "${APPLE_ID}" \
      --password "${APPLE_PASSWORD}" \
      --team-id "${APPLE_TEAM_ID}" \
      --wait
    log "Stapling notarization ticket"
    xcrun stapler staple "${DMG_OUT}"
  fi

  verify_artifacts "${UNI_DIR}/Atlas.app" "${DMG_OUT}"
  APP_PATHS+=("${UNI_DIR}/Atlas.app")
  DMG_PATHS+=("${DMG_OUT}")
else
  # ── One signed + notarized dmg per requested architecture ─────────────────
  # Factored into a function so BOTH=1 is a loop rather than a second copy of
  # this whole pipeline. Every artifact it produces is verified before the next
  # architecture starts, so a failure names the arch that failed.
  build_signed_dmg() {
    local target="$1"
    local bundle_root="src-tauri/target/${target}/release/bundle"

    log "Cleaning ${bundle_root}"
    rm -rf "${bundle_root}"

    # `--bundles app` skips Tauri's bundle_dmg.sh step, which is fragile (it
    # depends on create-dmg / AppleScript timing and can fail mid-pipeline
    # even when signing + notarization succeed). We still get a fully signed,
    # notarized, stapled .app from Tauri; the DMG is then built manually
    # with hdiutil — same path the UNIVERSAL=1 branch uses.
    log "Building Atlas for ${target} (.app only — Tauri's DMG packager is skipped)"
    bun run tauri build --target "${target}" --bundles app

    local app_path="${bundle_root}/macos/Atlas.app"
    if [[ ! -d "${app_path}" ]]; then
      err ".app not found at ${app_path}"
      exit 1
    fi
    ok "Tauri built + signed + notarized + stapled ${app_path}"

    # Build the DMG ourselves. Stage the .app + a /Applications symlink so
    # the user gets the standard drag-to-install gesture without any custom
    # AppleScript or layout JSON.
    local dmg_dir="${bundle_root}/dmg"
    mkdir -p "${dmg_dir}"
    local version arch dmg_path
    version="$(grep -m1 '"version"' src-tauri/tauri.conf.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')"
    # The arch suffix is what makes two dmgs from one release distinguishable in
    # a downloads folder: Atlas_0.3.0_aarch64.dmg vs Atlas_0.3.0_x86_64.dmg.
    arch="$(echo "${target}" | cut -d- -f1)"
    dmg_path="${dmg_dir}/Atlas_${version}_${arch}.dmg"
    rm -f "${dmg_path}"

    local staging
    staging="$(mktemp -d)"
    cp -R "${app_path}" "${staging}/Atlas.app"
    ln -s /Applications "${staging}/Applications"

    log "Building DMG at ${dmg_path}"
    hdiutil create \
      -volname "Atlas" \
      -srcfolder "${staging}" \
      -ov \
      -format UDZO \
      "${dmg_path}" >/dev/null
    rm -rf "${staging}"

    log "Setting DMG icon"
    bash "$(dirname "$0")/set-dmg-icon.sh" src-tauri/icons/icon.icns "${dmg_path}"

    log "Signing DMG"
    codesign --force --sign "${APPLE_SIGNING_IDENTITY}" "${dmg_path}"

    if [[ "${SKIP_NOTARIZE}" != "1" ]]; then
      log "Submitting DMG for notarization (.app inside is already notarized — this is fast)"
      xcrun notarytool submit "${dmg_path}" \
        --apple-id "${APPLE_ID}" \
        --password "${APPLE_PASSWORD}" \
        --team-id "${APPLE_TEAM_ID}" \
        --wait
      log "Stapling DMG ticket"
      xcrun stapler staple "${dmg_path}"
    fi

    verify_artifacts "${app_path}" "${dmg_path}"
    APP_PATHS+=("${app_path}")
    DMG_PATHS+=("${dmg_path}")
  }

  for t in "${TARGETS[@]}"; do
    log ""
    log "═══ ${t} ═══"
    build_signed_dmg "${t}"
  done
fi

# ── 8. Done ─────────────────────────────────────────────────────────────────
log ""
ok "Atlas is ready to ship:"
for dmg in "${DMG_PATHS[@]}"; do
  printf "      %s  (%s MB)\n" "${dmg}" "$(du -m "${dmg}" | awk '{print $1}')"
done
log ""
log "Upload the .dmg directly to beta users. They drag it to Applications,"
log "the stapled ticket lets Gatekeeper accept it offline."
if [[ ${#DMG_PATHS[@]} -gt 1 ]]; then
  log ""
  log "Two architectures: the aarch64 dmg is for Apple Silicon, x86_64 for Intel."
  log "An Intel dmg also runs on Apple Silicon under Rosetta, but slower — publish"
  log "both and let the download page pick, rather than shipping only x86_64."
fi
