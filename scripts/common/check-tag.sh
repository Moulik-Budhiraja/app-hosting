#!/usr/bin/env bash
# Checks a release tag and prints version= and build= lines ($GITHUB_OUTPUT
# format). The tag must be <prefix>X.Y.Z and point at a commit on origin/main.
#
#   scripts/common/check-tag.sh <tag> [prefix] >> "$GITHUB_OUTPUT"
#
# Run inside the app repo's checkout. The build follows DESIGN.md:
# X*100000000 + Y*100000 + Z*100, so 1.2.3 is 100200300.
# SKIP_MAIN_CHECK=1 skips the origin/main check (local dry runs).
set -euo pipefail
# shellcheck source=scripts/common/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag=${1:?usage: check-tag.sh <tag> [prefix]}
prefix=${2:-v}
[[ $tag == "$prefix"* ]] || die "tag $tag doesn't start with $prefix"
version=${tag#"$prefix"}
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || die "tags look like ${prefix}1.2.3, not $tag"
major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}
(( minor < 1000 && patch < 1000 )) || die "minor and patch must be below 1000"
build=$(( major * 100000000 + minor * 100000 + patch * 100 ))

if [[ ${SKIP_MAIN_CHECK:-0} != 1 ]]; then
  git fetch --quiet --no-tags origin main
  commit=$(git rev-parse "$tag^{commit}")
  git merge-base --is-ancestor "$commit" FETCH_HEAD || die "$tag points at $commit, which isn't on main; tag a commit on main"
fi

echo "version=$version"
echo "build=$build"
