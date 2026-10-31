#!/usr/bin/env bash
# Releases from this Mac instead of the macOS runner, with the same build,
# signing and publish steps as the workflow. For when the runner is down.
# Run it from the app repo (the folder holding apps.json), on a clean commit:
#
#   ~/path/to/apps/scripts/mac/release-local.sh <version> [--notes-file notes.md]
#
# Uses the Developer ID and App Store Connect key in $SIGNING_DIR
# (default ~/.config/predictor-release: developer-id.p12, certificate-password,
# AuthKey_<id>.p8). APPLE_ISSUER_ID comes from the environment or from
# appleIssuerId in ~/.config/apps/config.json. Publishing uses `apps` (on PATH,
# or this repo's cli/dist) with the admin login for the app's remote, and the
# Sparkle key in the keychain. Afterwards, tag the commit so history matches.
# DRY_RUN=1 signs without notarizing or publishing.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/mac/lib.sh
source "$here/lib.sh"

version=${1:?usage: release-local.sh <version> [--notes-file notes.md]}
shift
notes_args=("$@")
[[ -f apps.json ]] || die "run this from the app repo (no apps.json here)"
[[ -z $(git status --porcelain) ]] || die "commit first, so the release matches a commit"
dry_run=${DRY_RUN:-0}

signing_dir=${SIGNING_DIR:-$HOME/.config/predictor-release}
key_file=$(find "$signing_dir" -maxdepth 1 -name 'AuthKey_*.p8' -print -quit)
[[ -f $signing_dir/developer-id.p12 && -f $signing_dir/certificate-password ]] \
  || die "$signing_dir needs developer-id.p12 and certificate-password"

if [[ -z ${APPLE_ISSUER_ID:-} && -f $HOME/.config/apps/config.json ]]; then
  APPLE_ISSUER_ID=$(node -e 'try { process.stdout.write(require(process.argv[1]).appleIssuerId ?? "") } catch {}' "$HOME/.config/apps/config.json")
fi
if [[ $dry_run != 1 ]]; then
  [[ -n $key_file ]] || die "no AuthKey_*.p8 in $signing_dir"
  [[ -n ${APPLE_ISSUER_ID:-} ]] || die "set APPLE_ISSUER_ID, or appleIssuerId in ~/.config/apps/config.json"
fi

apps_cli=(apps)
if [[ $dry_run != 1 ]] && ! command -v apps >/dev/null; then
  [[ -f $here/../../cli/dist/index.js ]] || die "install the apps CLI, or build it in $(cd "$here/../.." && pwd)/cli"
  apps_cli=(node "$here/../../cli/dist/index.js")
fi

settings=$("$here/read-config.sh" apps.json)
tag_prefix=$(grep -m1 '^tag_prefix=' <<<"$settings" | cut -d= -f2-)
eval "$(SKIP_MAIN_CHECK=1 "$here/check-tag.sh" "$tag_prefix$version" "$tag_prefix" | sed 's/^/release_/')"
# shellcheck disable=SC2154 # set by the eval above
export VERSION=$release_version BUILD=$release_build

APPLE_CERTIFICATE_PATH="$signing_dir/developer-id.p12"
APPLE_CERTIFICATE_PASSWORD=$(tr -d '\n' < "$signing_dir/certificate-password")
export APPLE_CERTIFICATE_PATH APPLE_CERTIFICATE_PASSWORD APPLE_ISSUER_ID
if [[ -n $key_file ]]; then
  APPLE_API_KEY_PATH=$key_file
  APPLE_KEY_ID=$(basename "$key_file" .p8)
  APPLE_KEY_ID=${APPLE_KEY_ID#AuthKey_}
  export APPLE_API_KEY_PATH APPLE_KEY_ID
fi

eval "$("$here/keychain.sh" create)"
trap '"$here/keychain.sh" delete' EXIT
unset APPLE_CERTIFICATE_PASSWORD

[[ $dry_run == 1 ]] && export SKIP_NOTARIZE=1
outputs=$("$here/build-release.sh" apps.json)
dmg=$(grep -m1 '^dmg=' <<<"$outputs" | cut -d= -f2-)
zip=$(grep -m1 '^zip=' <<<"$outputs" | cut -d= -f2-)
blockmap=$(grep -m1 '^blockmap=' <<<"$outputs" | cut -d= -f2-)

if [[ $dry_run == 1 ]]; then
  note "dry run: built $dmg (signed, not notarized, not published)"
  exit 0
fi

publish=("${apps_cli[@]}" publish --version "$VERSION" --build "$BUILD" --dmg "$dmg")
[[ -n $zip ]] && publish+=(--zip "$zip")
[[ -n $blockmap ]] && publish+=(--blockmap "$blockmap")
if (( ${#notes_args[@]} )); then
  publish+=("${notes_args[@]}")
fi
"${publish[@]}"
note "published $VERSION. Tag this commit ${tag_prefix}$VERSION and push the tag; the release workflow sees the version is already out and stops."
