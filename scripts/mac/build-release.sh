#!/usr/bin/env bash
# Builds, signs, notarizes and verifies a release as apps.json describes it.
# Both the release workflow and local releases run this. Run it from the
# app repo (the folder holding apps.json), after keychain.sh create:
#
#   VERSION=1.2.3 BUILD=100200300 scripts/mac/build-release.sh [apps.json] >> "$GITHUB_OUTPUT"
#
# Prints dmg=, zip= and blockmap= lines (paths of what to publish),
# minimum_system_version= (the app's LSMinimumSystemVersion, may be empty) and
# icon= (a PNG of the app's icon for its download page, empty if it has none).
# Nothing else goes to stdout: build, signing and notary output goes to stderr.
#
# Env: VERSION, BUILD; APPS_KEYCHAIN, APPS_SIGN_IDENTITY, APPS_SIGN_NAME and
# APPS_NOTARY_KEY from keychain.sh; APPLE_KEY_ID and APPLE_ISSUER_ID (or
# NOTARY_PROFILE, native only). SKIP_NOTARIZE=1 signs without notarizing,
# for a local dry run; the result isn't publishable.
set -euo pipefail
# Only the key=value lines may reach stdout, since callers append it to
# $GITHUB_OUTPUT. Tools like `xcrun stapler` print progress to stdout, so
# everything else goes to stderr and the results go to fd 3.
exec 3>&1 1>&2
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/mac/lib.sh
source "$here/lib.sh"

config=${1:-apps.json}
: "${VERSION:?VERSION is unset}" "${BUILD:?BUILD is unset}"
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION must look like 1.2.3"
[[ $BUILD =~ ^[0-9]+$ ]] || die "BUILD must be a whole number"
export VERSION BUILD
require_keychain
skip_notarize=${SKIP_NOTARIZE:-0}

settings=$("$here/read-config.sh" "$config")
setting() {
  local line
  line=$(grep -m1 "^$1=" <<<"$settings" || true)
  printf '%s' "${line#*=}"
}
kind=$(setting kind)
command=$(setting command)

notarize() {
  if [[ $skip_notarize == 1 ]]; then
    note "SKIP_NOTARIZE=1: not notarizing $(basename "$1")"
  else
    "$here/notarize.sh" "$1"
  fi
}

minimum_system_version() {
  /usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$1/Contents/Info.plist" 2>/dev/null || true
}

# The download page shows the icon, but a release never fails over it.
icon_png() {
  local png="$out_dir/icon.png"
  rm -f "$png"
  if "$here/app-icon.sh" "$1" "$png"; then
    printf '%s' "$png"
  fi
}

out_dir="dist/apps-release"
mkdir -p "$out_dir"
# Ignore the output without touching the app's .gitignore, so the tree stays
# clean for the next release-local.sh, and DMGs are never committed.
[[ -f $out_dir/.gitignore ]] || printf '*\n' > "$out_dir/.gitignore"

if [[ $kind == native ]]; then
  app=$(setting app_path)
  entitlements=$(setting entitlements)
  dmg_name=$(setting dmg_name)

  note "building: $command"
  rm -rf "$app"
  bash -c "$command"
  [[ -d $app ]] || die "the build command didn't produce $app"

  version_in_app=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || true)
  build_in_app=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist" 2>/dev/null || true)
  [[ $version_in_app == "$VERSION" ]] || die "$app says version '$version_in_app', expected $VERSION; the build command must use \$VERSION"
  [[ $build_in_app == "$BUILD" ]] || die "$app says build '$build_in_app', expected $BUILD; the build command must use \$BUILD"

  "$here/sign-app.sh" "$app" ${entitlements:+"$entitlements"}
  notarize "$app"
  dmg="$out_dir/$dmg_name-$VERSION.dmg"
  "$here/make-dmg.sh" "$app" "$dmg" "$(basename "$app" .app)"
  notarize "$dmg"
  if [[ $skip_notarize != 1 ]]; then
    "$here/verify.sh" "$dmg" "$app"
  fi
  echo "dmg=$dmg" >&3
  echo "zip=" >&3
  echo "blockmap=" >&3
  echo "minimum_system_version=$(minimum_system_version "$app")" >&3
  echo "icon=$(icon_png "$app")" >&3
  exit 0
fi

# Electron: electron-builder signs and notarizes the app itself, with the
# keychain and key keychain.sh set up.
: "${APPS_SIGN_NAME:?run keychain.sh create first}"
export CSC_KEYCHAIN=$APPS_KEYCHAIN
export CSC_NAME=$APPS_SIGN_NAME
if [[ $skip_notarize != 1 ]]; then
  : "${APPS_NOTARY_KEY:?the App Store Connect key is needed (APPLE_API_KEY_BASE64 or APPLE_API_KEY_PATH for keychain.sh)}"
  : "${APPLE_KEY_ID:?APPLE_KEY_ID is unset}" "${APPLE_ISSUER_ID:?APPLE_ISSUER_ID is unset}"
  export APPLE_API_KEY=$APPS_NOTARY_KEY APPLE_API_KEY_ID=$APPLE_KEY_ID APPLE_API_ISSUER=$APPLE_ISSUER_ID
fi

resolve() {
  local value=$1
  printf '%s' "${value//\{version\}/$VERSION}"
}
dmg=$(resolve "$(setting dmg)")
zip=$(resolve "$(setting zip)")
blockmap=$(resolve "$(setting blockmap)")

note "building: $command"
# Apple's timestamp server sometimes fails one signature in the middle of
# electron-builder's run, so the whole build is tried again.
retry 3 bash -c "$command"
for f in "$dmg" "$zip" ${blockmap:+"$blockmap"}; do
  [[ -f $f ]] || die "the build command didn't produce $f"
done

# The app inside the update zip must be signed, notarized and stapled.
check="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/apps-zip.XXXXXX")"
trap 'rm -rf "$check"' EXIT
ditto -x -k "$zip" "$check"
zipped_app=$(find "$check" -maxdepth 1 -name '*.app' -print -quit)
[[ -n $zipped_app ]] || die "$zip doesn't contain an .app at its top level"
version_in_app=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$zipped_app/Contents/Info.plist")
[[ $version_in_app == "$VERSION" ]] || die "the zipped app says version '$version_in_app', expected $VERSION"

# The DMG is what people download first, so it is notarized too.
if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then
  if ! codesign --verify --strict "$dmg" >/dev/null 2>&1; then
    retry 3 codesign --force --keychain "$APPS_KEYCHAIN" --sign "$APPS_SIGN_IDENTITY" --timestamp "$dmg"
  fi
  notarize "$dmg"
fi
if [[ $skip_notarize != 1 ]]; then
  "$here/verify.sh" "$dmg" "$zipped_app"
fi
echo "dmg=$dmg" >&3
echo "zip=$zip" >&3
echo "blockmap=$blockmap" >&3
echo "minimum_system_version=$(minimum_system_version "$zipped_app")" >&3
echo "icon=$(icon_png "$zipped_app")" >&3
