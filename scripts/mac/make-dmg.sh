#!/usr/bin/env bash
# Wraps a signed .app in a compressed DMG with an /Applications shortcut, and
# signs the DMG. Notarize it afterwards with notarize.sh.
#
#   scripts/mac/make-dmg.sh <App.app> <out.dmg> [volume name]
#
# Needs APPS_KEYCHAIN and APPS_SIGN_IDENTITY from keychain.sh. The volume name
# defaults to the app's name.
set -euo pipefail
# shellcheck source=scripts/mac/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

app=${1:?usage: make-dmg.sh <App.app> <out.dmg> [volume name]}
out=${2:?usage: make-dmg.sh <App.app> <out.dmg> [volume name]}
app=${app%/}
volume=${3:-$(basename "$app" .app)}
[[ -d $app && $app == *.app ]] || die "$app is not an .app bundle"
[[ $out == *.dmg ]] || die "$out should end in .dmg"
require_keychain

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/apps-dmg.XXXXXX")
trap 'rm -rf "$work"' EXIT
root="$work/root"
mkdir -p "$root" "$(dirname "$out")"
ditto "$app" "$root/$(basename "$app")"
ln -s /Applications "$root/Applications"

rm -f "$out"
# hdiutil occasionally fails with "Resource busy" on a busy machine.
retry 3 hdiutil create -volname "$volume" -srcfolder "$root" -fs HFS+ -format UDZO -ov "$out" >/dev/null
retry 3 codesign --force --keychain "$APPS_KEYCHAIN" --sign "$APPS_SIGN_IDENTITY" --timestamp "$out"
codesign --verify --strict --verbose=2 "$out"
note "made $out"
