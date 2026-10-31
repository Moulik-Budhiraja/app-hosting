# shellcheck shell=bash
# Shared helpers for the scripts in scripts/mac. Source it; don't run it.
#
#   # shellcheck source=scripts/mac/lib.sh
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

die() {
  echo "error: $*" >&2
  exit 1
}

note() {
  echo "==> $*" >&2
}

# retry <attempts> <command...>
# Apple's timestamp and notary services fail now and then, so signing and
# notarizing are tried again after a pause.
retry() {
  local attempts=$1 n=1
  shift
  until "$@"; do
    if (( n >= attempts )); then
      echo "error: failed after $attempts attempts: $1" >&2
      return 1
    fi
    echo "warning: attempt $n of $attempts failed, trying again in $(( n * 20 ))s: $1" >&2
    sleep $(( n * 20 ))
    n=$(( n + 1 ))
  done
}

# Writes NAME=value for later steps: to $GITHUB_ENV in Actions, and as an
# export line on stdout so a local caller can `eval` it.
export_var() {
  local name=$1 value=$2
  [[ $value != *$'\n'* ]] || die "$name can't contain a newline"
  export "$name=$value"
  if [[ -n ${GITHUB_ENV:-} ]]; then
    printf '%s=%s\n' "$name" "$value" >> "$GITHUB_ENV"
  fi
  printf 'export %s=%q\n' "$name" "$value"
}

require_keychain() {
  : "${APPS_KEYCHAIN:?Run scripts/mac/keychain.sh create first (APPS_KEYCHAIN is unset)}"
  : "${APPS_SIGN_IDENTITY:?Run scripts/mac/keychain.sh create first (APPS_SIGN_IDENTITY is unset)}"
  [[ -f $APPS_KEYCHAIN ]] || die "keychain $APPS_KEYCHAIN is missing"
}
