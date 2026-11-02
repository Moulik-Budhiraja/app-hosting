#!/usr/bin/env bash
# Reads and checks an app repo's apps.json (see DESIGN.md) and prints one
# platform's settings as key=value lines, the format $GITHUB_OUTPUT takes:
#
#   scripts/common/read-config.sh [path/to/apps.json] [mac|windows] >> "$GITHUB_OUTPUT"
#
# The platform defaults to mac. Keys for every platform: app, remote_name,
# remote_url, updater, tag_prefix (the first prefix), tag_prefixes (all of them,
# longest first, separated by spaces), kind, command. For mac native builds:
# app_path, entitlements, dmg_name; for mac electron builds: dmg, zip,
# blockmap. For windows: installer, blockmap, minimum_system_version, icon.
# Artifact paths may still contain {version}. A legacy top-level "build" reads
# as builds.mac. The checks live in read-config.mjs. Needs node.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/common/lib.sh
source "$here/lib.sh"

config=${1:-apps.json}
platform=${2:-mac}
[[ -f $config ]] || die "$config not found"
command -v node >/dev/null || die "node is needed to read $config"
node "$here/read-config.mjs" "$config" "$platform"
