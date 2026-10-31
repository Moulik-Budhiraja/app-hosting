#!/usr/bin/env bash
# Notarizes a signed .app, .dmg, .pkg or .zip with Apple and staples the ticket.
# An .app is zipped for upload and the ticket is stapled to the app itself; a
# .zip can't hold a ticket, so it is only notarized.
#
#   scripts/mac/notarize.sh <path>
#
# Credentials, either:
#   APPS_NOTARY_KEY (from keychain.sh) or APPLE_API_KEY_PATH, or APPLE_API_KEY_BASE64,
#   plus APPLE_KEY_ID and APPLE_ISSUER_ID           App Store Connect API key
# or:
#   NOTARY_PROFILE      a `xcrun notarytool store-credentials` profile (local)
#
# A rejection prints Apple's log and fails at once. Network or service errors
# are tried again, up to 3 times.
set -euo pipefail
# shellcheck source=scripts/mac/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

target=${1:?usage: notarize.sh <App.app|file.dmg|file.pkg|file.zip>}
target=${target%/}
[[ -e $target ]] || die "$target not found"

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/apps-notary.XXXXXX")
trap 'rm -rf "$work"' EXIT

auth=()
if [[ -n ${NOTARY_PROFILE:-} ]]; then
  auth=(--keychain-profile "$NOTARY_PROFILE")
else
  key=${APPS_NOTARY_KEY:-${APPLE_API_KEY_PATH:-}}
  if [[ -z $key && -n ${APPLE_API_KEY_BASE64:-} ]]; then
    key="$work/notary.p8"
    printf '%s' "$APPLE_API_KEY_BASE64" | tr -d '\r\n ' | base64 --decode > "$key"
    chmod 600 "$key"
  fi
  [[ -n $key && -f $key ]] || die "no App Store Connect key: set APPS_NOTARY_KEY, APPLE_API_KEY_PATH or APPLE_API_KEY_BASE64, or NOTARY_PROFILE"
  : "${APPLE_KEY_ID:?APPLE_KEY_ID is unset}" "${APPLE_ISSUER_ID:?APPLE_ISSUER_ID is unset}"
  auth=(--key "$key" --key-id "$APPLE_KEY_ID" --issuer "$APPLE_ISSUER_ID")
fi

upload=$target
staple=1
case $target in
  *.app)
    upload="$work/$(basename "$target" .app).zip"
    ditto -c -k --keepParent "$target" "$upload"
    ;;
  *.dmg | *.pkg) ;;
  *.zip) staple=0 ;;
  *) die "don't know how to notarize $target" ;;
esac

result="$work/result.json"
submit() {
  xcrun notarytool submit "$upload" "${auth[@]}" --wait --timeout 45m --output-format json > "$result"
}

note "notarizing $(basename "$target")"
attempt=1
while :; do
  if submit; then
    break
  fi
  # notarytool exits non-zero for a rejection as well as for a network error.
  # A rejection has a status in its output; only the latter is worth retrying.
  status=$(/usr/bin/plutil -extract status raw -o - "$result" 2>/dev/null || true)
  if [[ -n $status && $status != "In Progress" ]] || (( attempt >= 3 )); then
    break
  fi
  echo "warning: notarytool failed (attempt $attempt of 3), trying again in $(( attempt * 30 ))s" >&2
  sleep $(( attempt * 30 ))
  attempt=$(( attempt + 1 ))
done

status=$(/usr/bin/plutil -extract status raw -o - "$result" 2>/dev/null || true)
id=$(/usr/bin/plutil -extract id raw -o - "$result" 2>/dev/null || true)
if [[ $status != Accepted ]]; then
  echo "error: notarization of $(basename "$target") ended as '${status:-unknown}'" >&2
  if [[ -n $id ]]; then
    xcrun notarytool log "$id" "${auth[@]}" >&2 || true
  else
    cat "$result" >&2 || true
  fi
  exit 1
fi
note "accepted ($id)"

if (( staple )); then
  # The ticket can take a moment to reach Apple's CDN after acceptance.
  retry 3 xcrun stapler staple "$target"
  xcrun stapler validate "$target"
fi
