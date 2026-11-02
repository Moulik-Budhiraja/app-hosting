# shellcheck shell=bash
# Helpers shared by every script in scripts/. Source it; don't run it.
#
#   # shellcheck source=scripts/common/lib.sh
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

die() {
  echo "error: $*" >&2
  exit 1
}

note() {
  echo "==> $*" >&2
}
