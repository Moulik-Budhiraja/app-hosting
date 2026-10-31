#!/usr/bin/env bash
# The checks a release must pass before it is published: valid signatures,
# Gatekeeper acceptance and stapled tickets.
#
#   scripts/mac/verify.sh <file.dmg> [App.app]
#
# The DMG must be signed, notarized and stapled. If an app is given it must
# also pass a strict deep signature check and Gatekeeper's execute check.
set -euo pipefail
# shellcheck source=scripts/mac/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dmg=${1:?usage: verify.sh <file.dmg> [App.app]}
app=${2:-}

if [[ -n $app ]]; then
  app=${app%/}
  codesign --verify --deep --strict --verbose=2 "$app"
  spctl --assess --type execute --verbose=2 "$app"
  xcrun stapler validate "$app"
fi
codesign --verify --strict --verbose=2 "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
note "verified $(basename "$dmg")${app:+ and $(basename "$app")}"
