#!/usr/bin/env bash
# The release's version and tag, for release-linux.yml's build and publish
# jobs, which must agree on both. Prints `version=` and `tag=` lines, which
# the workflow appends to $GITHUB_OUTPUT.
#
# Version, first match wins: INPUT_VERSION (a manual run's input), the pushed
# tag's name, package.json. Tag: INPUT_TAG, the pushed tag, alpha-<version>.
# The prefixes alpha-, exp- and v are stripped to leave plain semver.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -n "${INPUT_VERSION:-}" ]; then
  raw="$INPUT_VERSION"
elif [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
  raw="${GITHUB_REF_NAME}"
else
  raw="$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')"
fi
version="${raw#alpha-}"
version="${version#exp-}"
version="${version#v}"

if [ -n "${INPUT_TAG:-}" ]; then
  tag="$INPUT_TAG"
elif [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
  tag="${GITHUB_REF_NAME}"
else
  tag="alpha-${version}"
fi

echo "version=${version}"
echo "tag=${tag}"
