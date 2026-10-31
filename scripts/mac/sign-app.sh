#!/usr/bin/env bash
# Signs a .app with the Developer ID for notarization: every piece of nested
# code from the inside out (frameworks, XPC services, helper apps, app
# extensions, plug-ins, login items, dylibs and loose executables), then the
# app itself. Hardened runtime and a secure timestamp on everything.
#
#   scripts/mac/sign-app.sh <path/to/App.app> [entitlements.plist]
#
# Needs APPS_KEYCHAIN and APPS_SIGN_IDENTITY from keychain.sh. Nested code
# keeps the entitlements it was built with. The app gets the given
# entitlements file; without one it keeps the entitlements it already has.
# Debug-only entitlements (get-task-allow) are refused, since notarization
# rejects them.
set -euo pipefail
# shellcheck source=scripts/mac/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

app=${1:?usage: sign-app.sh <App.app> [entitlements.plist]}
entitlements=${2:-}
app=${app%/}
[[ -d $app && $app == *.app ]] || die "$app is not an .app bundle"
[[ -z $entitlements || -f $entitlements ]] || die "entitlements file $entitlements not found"
require_keychain

sign() {
  codesign --force --keychain "$APPS_KEYCHAIN" --sign "$APPS_SIGN_IDENTITY" \
    --options runtime --timestamp "$@"
}

is_macho() {
  local kind
  kind=$(file -b "$1" 2>/dev/null) || return 1
  [[ $kind == Mach-O* ]]
}

main_executable=""
if [[ -f $app/Contents/Info.plist ]]; then
  name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null || true)
  [[ -n $name ]] && main_executable="$app/Contents/MacOS/$name"
fi

# Collect nested code as "<depth> <path>". find doesn't follow symlinks, so a
# framework's Versions/Current link and its top-level links aren't walked
# twice; the guard below covers anything that slips through.
items=()
while IFS= read -r -d '' path; do
  [[ $path == */Versions/Current/* ]] && continue
  # Resource-only bundles (SwiftPM makes these) hold no code; they're sealed
  # as part of the app's resources instead.
  if [[ $path == *.bundle || $path == *.plugin ]] && [[ ! -d $path/Contents/MacOS ]]; then
    continue
  fi
  items+=("$path")
done < <(find "$app/Contents" -mindepth 1 -type d \( \
    -name '*.framework' -o -name '*.xpc' -o -name '*.app' -o -name '*.appex' \
    -o -name '*.bundle' -o -name '*.plugin' -o -name '*.systemextension' \
  \) -print0)
while IFS= read -r -d '' path; do
  [[ $path == */Versions/Current/* || $path == "$main_executable" ]] && continue
  is_macho "$path" && items+=("$path")
done < <(find "$app/Contents" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.so' \) -print0)

sorted=()
if (( ${#items[@]} )); then
  while IFS= read -r line; do
    sorted+=("${line#* }")
  done < <(for path in "${items[@]}"; do
      depth=$(tr -cd '/' <<<"$path" | wc -c | tr -d ' ')
      printf '%s %s\n' "$depth" "$path"
    done | sort -rn -k1,1 | uniq)
fi

# bash 3.2 (macOS's /bin/bash) treats an empty "${array[@]}" as unset.
if (( ${#sorted[@]} )); then
  for path in "${sorted[@]}"; do
    note "signing ${path#"$app"/}"
    retry 3 sign --preserve-metadata=entitlements "$path"
  done
fi

note "signing $(basename "$app")"
if [[ -n $entitlements ]]; then
  retry 3 sign --entitlements "$entitlements" "$app"
else
  retry 3 sign --preserve-metadata=entitlements "$app"
fi

codesign --verify --deep --strict --verbose=2 "$app"
details=$(codesign -dvv "$app" 2>&1)
grep -q 'flags=.*runtime' <<<"$details" || die "$app is missing the hardened runtime"
grep -q '^Timestamp=' <<<"$details" || die "$app has no secure timestamp"
if codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q 'com.apple.security.get-task-allow</key><true/>'; then
  die "$app has the get-task-allow entitlement (a Debug build?); notarization would reject it"
fi
note "signed $app"
