#!/usr/bin/env bash
# Sign a Linux release with the release GPG key, when there is one.
#
# Usage: scripts/linux/sign-release.sh rpm|sums <artifacts dir>
#   rpm   sign every *.rpm in place (before the checksums are taken)
#   sums  write SHA256SUMS.txt.asc, a detached signature over the checksums,
#         and atlas-release-signing-key.asc, the public half
#
# Environment: GPG_KEY (the armored private key), GPG_PASSPHRASE (optional).
# With GPG_KEY empty it prints a GitHub Actions warning and exits 0: the
# release still ships, with checksums and build provenance but unsigned, and
# the warning on the run says so. docs/reference/linux-support.md says how to
# create the key and which secrets hold it.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 rpm|sums <artifacts dir>" >&2
  exit 2
fi
MODE="$1"
ART="$2"

if [ -z "${GPG_KEY:-}" ]; then
  echo "::warning title=Linux release unsigned::LINUX_RELEASE_GPG_KEY is not set, so the ${MODE} signature was skipped"
  exit 0
fi

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$GNUPGHOME"' EXIT
chmod 700 "$GNUPGHOME"
PASSFILE="$GNUPGHOME/passphrase"
printf '%s' "${GPG_PASSPHRASE:-}" >"$PASSFILE"

gpg --batch --quiet --import <<<"$GPG_KEY"
FPR="$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/ {print $10; exit}')"
if [ -z "$FPR" ]; then
  echo "LINUX_RELEASE_GPG_KEY holds no secret key" >&2
  exit 1
fi
GPG_ARGS=(--batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" --local-user "$FPR")

case "$MODE" in
  rpm)
    if ! command -v rpmsign >/dev/null 2>&1; then
      echo "rpmsign is not installed (the rpm package)" >&2
      exit 1
    fi
    shopt -s nullglob
    rpms=("$ART"/*.rpm)
    if [ "${#rpms[@]}" -eq 0 ]; then
      echo "no rpm in $ART to sign" >&2
      exit 1
    fi
    for rpm in "${rpms[@]}"; do
      # rpm's own signing command, told who signs (`_gpg_name` in rpm 4,
      # `_openpgp_sign_id` in rpm 6) and how to unlock the key; both read
      # `_gpg_sign_cmd_extra_args`.
      rpmsign --addsign \
        --define "_gpg_name $FPR" \
        --define "_openpgp_sign_id $FPR" \
        --define "_gpg_sign_cmd_extra_args --batch --pinentry-mode loopback --passphrase-file $PASSFILE" \
        "$rpm"
      echo "signed $(basename "$rpm")"
    done
    ;;
  sums)
    sums="$ART/SHA256SUMS.txt"
    [ -f "$sums" ] || {
      echo "no $sums to sign" >&2
      exit 1
    }
    gpg "${GPG_ARGS[@]}" --armor --detach-sign --output "$sums.asc" "$sums"
    gpg --batch --verify "$sums.asc" "$sums"
    gpg --batch --armor --export "$FPR" >"$ART/atlas-release-signing-key.asc"
    echo "signed SHA256SUMS.txt with $FPR"
    ;;
  *)
    echo "unknown mode: $MODE" >&2
    exit 2
    ;;
esac
