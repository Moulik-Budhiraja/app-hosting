#!/usr/bin/env bash
# Picks a release's notes and prints file=<path> ($GITHUB_OUTPUT format), or
# nothing when there are none.
#
#   scripts/common/release-notes.sh <tag> [notes-file] >> "$GITHUB_OUTPUT"
#
# notes-file is relative to the repo root. When it's set and holds text other
# than whitespace, it's the notes. Otherwise the annotated tag's message is,
# as before notes-file existed; a lightweight tag has none. Run inside the
# app repo's checkout. The notes are copied to $RUNNER_TEMP/release-notes.md.
# SKIP_TAG_FETCH=1 skips fetching the tag object from origin (tests).
set -euo pipefail
# shellcheck source=scripts/common/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag=${1:?usage: release-notes.sh <tag> [notes-file]}
notes_file=${2:-}
out="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/release-notes.md"
rm -f "$out"

has_text() { [[ -s $1 ]] && grep -q '[^[:space:]]' "$1"; }

if [[ -n $notes_file ]]; then
  # Keep it inside the repo: no absolute path and no .. segment.
  [[ $notes_file != /* && $notes_file != \\* && ! $notes_file =~ ^[A-Za-z]: ]] \
    || die "notes-file must be relative to the repo root, not $notes_file"
  [[ ! $notes_file =~ (^|[/\\])\.\.([/\\]|$) ]] || die "notes-file can't contain .., not $notes_file"
  path="$(git rev-parse --show-toplevel)/$notes_file"
  if [[ -f $path ]] && has_text "$path"; then
    cp "$path" "$out"
    echo "file=$out"
    exit 0
  fi
  echo "::warning::notes-file $notes_file is missing or empty, so the release notes come from the tag message." >&2
fi

# An annotated tag's message. actions/checkout fetches the pushed tag as a
# lightweight tag, so fetch the tag object.
if [[ ${SKIP_TAG_FETCH:-0} != 1 ]]; then
  git fetch --quiet --force --no-tags origin "refs/tags/$tag:refs/tags/$tag"
fi
if [[ $(git cat-file -t "refs/tags/$tag") == tag ]]; then
  git tag -l --format='%(contents:subject)%0a%0a%(contents:body)' "$tag" | sed -e '/^-----BEGIN PGP SIGNATURE-----/,$d' > "$out"
fi
if [[ -f $out ]] && has_text "$out"; then
  echo "file=$out"
fi
