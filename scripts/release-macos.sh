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
#   ./scripts/release-macos.sh                          # aarch64 (Apple Silicon), signed + notarized
#   TARGET=x86_64-apple-darwin ./scripts/release-macos.sh   # Intel only
#   UNIVERSAL=1 ./scripts/release-macos.sh              # universal (arm64 + x86_64), slow
#   SKIP_NOTARIZE=1 ./scripts/release-macos.sh          # skip Apple round-trip (dev only)
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")/.."  # cd to repo root

# ── Config ──────────────────────────────────────────────────────────────────
# Developer ID identity. Override at the command line if you ever rotate certs.
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Adib Mohsin (PLKDA3WBJJ)}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-PLKDA3WBJJ}"

# Default build target. M-series Macs are the realistic beta-user audience;
# Intel + universal builds are opt-in.
TARGET="${TARGET:-aarch64-apple-darwin}"
UNIVERSAL="${UNIVERSAL:-0}"

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
  ensure_target "${TARGET}"
fi

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

# ── 5. Build ────────────────────────────────────────────────────────────────
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

  BUNDLE_ROOT="src-tauri/target/universal-apple-darwin/release/bundle"
  APP_PATH="${UNI_DIR}/Atlas.app"
  DMG_PATH="${DMG_OUT}"
else
  BUNDLE_ROOT="src-tauri/target/${TARGET}/release/bundle"
  log "Cleaning ${BUNDLE_ROOT}"
  rm -rf "${BUNDLE_ROOT}"

  # `--bundles app` skips Tauri's bundle_dmg.sh step, which is fragile (it
  # depends on create-dmg / AppleScript timing and can fail mid-pipeline
  # even when signing + notarization succeed). We still get a fully signed,
  # notarized, stapled .app from Tauri; the DMG is then built manually
  # with hdiutil — same path the UNIVERSAL=1 branch uses.
  log "Building Atlas for ${TARGET} (.app only — Tauri's DMG packager is skipped)"
  bun run tauri build --target "${TARGET}" --bundles app

  APP_PATH="${BUNDLE_ROOT}/macos/Atlas.app"
  if [[ ! -d "${APP_PATH}" ]]; then
    err ".app not found at ${APP_PATH}"
    exit 1
  fi
  ok "Tauri built + signed + notarized + stapled ${APP_PATH}"

  # Build the DMG ourselves. Stage the .app + a /Applications symlink so
  # the user gets the standard drag-to-install gesture without any custom
  # AppleScript or layout JSON.
  DMG_DIR="${BUNDLE_ROOT}/dmg"
  mkdir -p "${DMG_DIR}"
  DMG_PATH="${DMG_DIR}/Atlas_$(grep -m1 '"version"' src-tauri/tauri.conf.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')_$(echo "${TARGET}" | cut -d- -f1).dmg"
  rm -f "${DMG_PATH}"

  STAGING=$(mktemp -d)
  cp -R "${APP_PATH}" "${STAGING}/Atlas.app"
  ln -s /Applications "${STAGING}/Applications"

  log "Building DMG at ${DMG_PATH}"
  hdiutil create \
    -volname "Atlas" \
    -srcfolder "${STAGING}" \
    -ov \
    -format UDZO \
    "${DMG_PATH}" >/dev/null
  rm -rf "${STAGING}"

  log "Setting DMG icon"
  bash "$(dirname "$0")/set-dmg-icon.sh" src-tauri/icons/icon.icns "${DMG_PATH}"

  log "Signing DMG"
  codesign --force --sign "${APPLE_SIGNING_IDENTITY}" "${DMG_PATH}"

  if [[ "${SKIP_NOTARIZE}" != "1" ]]; then
    log "Submitting DMG for notarization (.app inside is already notarized — this is fast)"
    xcrun notarytool submit "${DMG_PATH}" \
      --apple-id "${APPLE_ID}" \
      --password "${APPLE_PASSWORD}" \
      --team-id "${APPLE_TEAM_ID}" \
      --wait
    log "Stapling DMG ticket"
    xcrun stapler staple "${DMG_PATH}"
  fi
fi

# ── 6. Verify artifacts exist ───────────────────────────────────────────────
if [[ ! -d "${APP_PATH}" ]]; then
  err ".app not found at ${APP_PATH}"
  exit 1
fi
if [[ -z "${DMG_PATH:-}" || ! -f "${DMG_PATH}" ]]; then
  err "No .dmg produced"
  exit 1
fi
ok "Built ${APP_PATH}"
ok "Built ${DMG_PATH}"

# ── 7. Verify signature + Gatekeeper ────────────────────────────────────────
log "Verifying codesign on the .app"
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
ok "Signature valid"

if [[ "${SKIP_NOTARIZE}" != "1" ]]; then
  log "Verifying Gatekeeper acceptance"
  if spctl --assess --type execute --verbose "${APP_PATH}"; then
    ok "Gatekeeper accepts the .app"
  else
    err "Gatekeeper rejected the .app — notarization probably failed"
    err "Check the build log above for the notarytool submission ID + log URL"
    exit 1
  fi

  log "Verifying the .dmg has a stapled ticket"
  if xcrun stapler validate "${DMG_PATH}"; then
    ok "Stapled ticket on .dmg"
  else
    err "Stapler validation failed on ${DMG_PATH}"
    exit 1
  fi
fi

# ── 8. Done ─────────────────────────────────────────────────────────────────
SIZE_MB=$(du -m "${DMG_PATH}" | awk '{print $1}')
log ""
ok "Atlas is ready to ship:"
printf "      %s  (%s MB)\n" "${DMG_PATH}" "${SIZE_MB}"
log ""
log "Upload the .dmg directly to beta users. They drag it to Applications,"
log "the stapled ticket lets Gatekeeper accept it offline."
