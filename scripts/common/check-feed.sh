#!/usr/bin/env bash
# Waits for a platform's live feed to offer a version that was just published,
# and fails if it doesn't within half a minute.
#
#   scripts/common/check-feed.sh <remote url> <app> <sparkle|electron> <mac|windows> <version>
#
# A beta (X.Y.Z-beta.N) is checked on its platform's beta feed, and any other
# version on the stable one. DESIGN.md lists the feeds.
set -euo pipefail
# shellcheck source=scripts/common/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage='usage: check-feed.sh <remote url> <app> <updater> <platform> <version>'
remote_url=${1:?$usage}
app=${2:?$usage}
updater=${3:?$usage}
platform=${4:?$usage}
version=${5:?$usage}
if [[ $version == *-beta.* ]]; then
  feeds=(appcast-beta.xml appcast-windows-beta.xml beta-mac.yml beta.yml)
else
  feeds=(appcast.xml appcast-windows.xml latest-mac.yml latest.yml)
fi
case "$updater/$platform" in
  sparkle/mac) name=${feeds[0]} ;;
  sparkle/windows) name=${feeds[1]} ;;
  electron/mac) name=${feeds[2]} ;;
  electron/windows) name=${feeds[3]} ;;
  *) die "no feed for $updater on $platform" ;;
esac
if [[ $updater == sparkle ]]; then
  pattern="<sparkle:shortVersionString>$version</sparkle:shortVersionString>"
else
  pattern="version: \"$version\""
fi

feed="$remote_url/$app/$name"
for _ in $(seq 1 10); do
  # Read the whole feed before searching it. grep -q on a pipe stops at the
  # first match, and curl then fails to write the rest of a feed that's larger
  # than the pipe holds, which pipefail turns into "not found".
  if body=$(curl --fail --silent --show-error --max-time 15 "$feed") && grep -qF -- "$pattern" <<<"$body"; then
    echo "$feed offers $version"
    exit 0
  fi
  sleep 3
done
echo "$feed doesn't offer $version" >&2
exit 1
