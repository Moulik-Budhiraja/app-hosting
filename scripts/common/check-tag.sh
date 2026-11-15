#!/usr/bin/env bash
# Checks a release tag and prints version=, build= and prefix= lines
# ($GITHUB_OUTPUT format). The tag must be <prefix>X.Y.Z, or <prefix>X.Y.Z-beta.N
# for a beta (N from 1 to 99), for one of the prefixes, and point at a commit on
# origin/main.
#
#   scripts/common/check-tag.sh <tag> [prefix...] >> "$GITHUB_OUTPUT"
#
# With several prefixes (apps.json tagPrefix as a list), the longest one the
# tag starts with gives the version, so overlapping prefixes such as v and
# v-win pick the more specific one. The prefix defaults to v.
# Run inside the app repo's checkout. The build follows DESIGN.md:
# X*100000000 + Y*100000 + Z*100, so 1.2.3 is 100200300. A beta takes one of the
# 99 builds below its version's: 1.2.3-beta.4 is 100200204.
# RELEASE_BRANCHES (apps.json releaseBranches, separated by spaces) names
# branches besides main that a tag may be on, such as release/*.
# SKIP_MAIN_CHECK=1 skips the branch check (local dry runs).
set -euo pipefail
# shellcheck source=scripts/common/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag=${1:?usage: check-tag.sh <tag> [prefix...]}
shift
(( $# )) || set -- v
prefixes=("$@")

prefix='' examples='' names=''
for candidate in "${prefixes[@]}"; do
  [[ -n $candidate ]] || die "a tag prefix can't be empty"
  examples+="${examples:+ or }${candidate}1.2.3"
  names+="${names:+ or }$candidate"
  if [[ $tag == "$candidate"* && ${#candidate} -gt ${#prefix} ]]; then
    prefix=$candidate
  fi
done
[[ -n $prefix ]] || die "tag $tag doesn't start with $names"
version=${tag#"$prefix"}
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-beta\.([1-9][0-9]?))?$ ]] \
  || die "tags look like $examples, or ${prefixes[0]}1.2.3-beta.1 for a beta, not $tag"
major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]} beta=${BASH_REMATCH[5]}
(( minor < 1000 && patch < 1000 )) || die "minor and patch must be below 1000"
build=$(( major * 100000000 + minor * 100000 + patch * 100 ))
if [[ -n $beta ]]; then
  build=$(( build - 100 + beta ))
  (( build > 0 )) || die "0.0.0 can't have a beta"
fi

if [[ ${SKIP_MAIN_CHECK:-0} != 1 ]]; then
  commit=$(git rev-parse "$tag^{commit}")
  git fetch --quiet --no-tags origin main
  if ! git merge-base --is-ancestor "$commit" FETCH_HEAD; then
    on=''
    # Unquoted on purpose: the patterns have no spaces (read-config checks), and
    # noglob keeps release/* from matching files here.
    set -o noglob
    for pattern in ${RELEASE_BRANCHES:-}; do
      while read -r _ ref; do
        git fetch --quiet --no-tags origin "$ref"
        if git merge-base --is-ancestor "$commit" FETCH_HEAD; then
          on=$ref
          break 2
        fi
      done < <(git ls-remote --heads origin "refs/heads/$pattern")
    done
    set +o noglob
    [[ -n $on ]] || die "$tag points at $commit, which isn't on main${RELEASE_BRANCHES:+ or a release branch ($RELEASE_BRANCHES)}; tag a commit on main"
  fi
fi

echo "version=$version"
echo "build=$build"
echo "prefix=$prefix"
