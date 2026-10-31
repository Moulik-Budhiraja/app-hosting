#!/usr/bin/env bash
# Creates a throwaway keychain holding only the Developer ID identity, and
# removes it again. Used by the release workflow and by local releases.
#
#   eval "$(scripts/mac/keychain.sh create)"
#   trap 'scripts/mac/keychain.sh delete' EXIT
#
# create reads the certificate from one of:
#   APPLE_CERTIFICATE_BASE64   base64 of the Developer ID .p12 (CI)
#   APPLE_CERTIFICATE_PATH     path to the .p12 (local)
# plus APPLE_CERTIFICATE_PASSWORD. If the App Store Connect key is given as
# APPLE_API_KEY_BASE64 (CI) or APPLE_API_KEY_PATH (local), it is written to the
# secret folder for notarize.sh.
#
# create exports (to $GITHUB_ENV in Actions, and as `export` lines on stdout):
#   APPS_SECRET_DIR      private temporary folder; delete removes it
#   APPS_KEYCHAIN        the throwaway keychain
#   APPS_SIGN_IDENTITY   SHA-1 of the Developer ID identity (for codesign)
#   APPS_SIGN_NAME       "Name (TEAMID)", the form electron-builder's CSC_NAME wants
#   APPS_TEAM_ID         the team ID
#   APPS_NOTARY_KEY      path of the .p8 (only when an API key was given)
#
# The keychain search list is saved and restored by delete. With
# APPS_KEYCHAIN_EXCLUSIVE=1 (the default when CI=true) only the throwaway
# keychain is searched until delete, so a copy of the same certificate in
# another keychain can't make an identity name ambiguous. Locally the
# throwaway keychain is put first and the others stay searchable.
set -euo pipefail
# shellcheck source=scripts/mac/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

create() {
  local password=${APPLE_CERTIFICATE_PASSWORD:-}
  [[ -n $password ]] || die "APPLE_CERTIFICATE_PASSWORD is unset"
  if [[ -z ${APPLE_CERTIFICATE_BASE64:-} && -z ${APPLE_CERTIFICATE_PATH:-} ]]; then
    die "set APPLE_CERTIFICATE_BASE64 or APPLE_CERTIFICATE_PATH"
  fi

  local parent=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
  local secret_dir
  secret_dir=$(mktemp -d "${parent%/}/apps-signing.XXXXXX")
  chmod 700 "$secret_dir"
  local keychain="$secret_dir/release.keychain-db"
  local keychain_password
  keychain_password=$(openssl rand -hex 24)

  # Saved before anything changes, so delete can put it back.
  security list-keychains -d user | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//' > "$secret_dir/original-keychains"

  local p12="$secret_dir/signing.p12"
  if [[ -n ${APPLE_CERTIFICATE_BASE64:-} ]]; then
    printf '%s' "$APPLE_CERTIFICATE_BASE64" | tr -d '\r\n ' | base64 --decode > "$p12"
  else
    cp "$APPLE_CERTIFICATE_PATH" "$p12"
  fi
  chmod 600 "$p12"

  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$p12" -k "$keychain" -P "$password" -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productsign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
  rm -f "$p12"

  local exclusive=${APPS_KEYCHAIN_EXCLUSIVE:-}
  if [[ -z $exclusive ]]; then
    [[ ${CI:-} == true ]] && exclusive=1 || exclusive=0
  fi
  local originals=()
  while IFS= read -r existing; do
    [[ -n $existing ]] && originals+=("$existing")
  done < "$secret_dir/original-keychains"
  if [[ $exclusive == 1 || ${#originals[@]} == 0 ]]; then
    security list-keychains -d user -s "$keychain"
  else
    security list-keychains -d user -s "$keychain" "${originals[@]}"
  fi

  local identities
  identities=$(security find-identity -v -p codesigning "$keychain" | grep '"Developer ID Application: ' || true)
  [[ $(grep -c . <<<"$identities") == 1 ]] || die "expected exactly one Developer ID Application identity in the certificate"
  local hash name
  hash=$(awk '{print $2}' <<<"$identities")
  name=$(sed -E 's/.*"Developer ID Application: (.*)"$/\1/' <<<"$identities")
  [[ $hash =~ ^[[:xdigit:]]{40}$ ]] || die "couldn't read the identity hash"
  local team=${name##*(}
  team=${team%)}

  export_var APPS_SECRET_DIR "$secret_dir"
  export_var APPS_KEYCHAIN "$keychain"
  export_var APPS_SIGN_IDENTITY "$hash"
  export_var APPS_SIGN_NAME "$name"
  export_var APPS_TEAM_ID "$team"

  if [[ -n ${APPLE_API_KEY_BASE64:-} || -n ${APPLE_API_KEY_PATH:-} ]]; then
    local p8="$secret_dir/notary.p8"
    if [[ -n ${APPLE_API_KEY_BASE64:-} ]]; then
      printf '%s' "$APPLE_API_KEY_BASE64" | tr -d '\r\n ' | base64 --decode > "$p8"
    else
      cp "$APPLE_API_KEY_PATH" "$p8"
    fi
    chmod 600 "$p8"
    export_var APPS_NOTARY_KEY "$p8"
  fi
  note "signing with Developer ID Application: $name"
}

delete() {
  local secret_dir=${APPS_SECRET_DIR:-}
  if [[ -z $secret_dir || ! -d $secret_dir ]]; then
    note "no signing folder to clean up"
    return 0
  fi
  local originals=()
  if [[ -f $secret_dir/original-keychains ]]; then
    while IFS= read -r existing; do
      [[ -n $existing ]] && originals+=("$existing")
    done < "$secret_dir/original-keychains"
  fi
  if (( ${#originals[@]} )); then
    security list-keychains -d user -s "${originals[@]}" || true
  fi
  security delete-keychain "$secret_dir/release.keychain-db" >/dev/null 2>&1 || true
  rm -rf "$secret_dir"
  note "removed the signing keychain and restored the keychain search list"
}

case ${1:-} in
  create) create ;;
  delete) delete ;;
  *) echo "usage: $0 create|delete" >&2; exit 2 ;;
esac
