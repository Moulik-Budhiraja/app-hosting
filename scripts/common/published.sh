#!/usr/bin/env bash
# Prints true if an app's releases.json lists a version with files for a
# platform, and false if not. Files without a platform are mac files, from
# releases published before Windows support.
#
#   scripts/common/published.sh <remote url> <app> <version> <mac|windows>
#
# Fails if the app doesn't exist on the remote. Needs node.
set -euo pipefail
# shellcheck source=scripts/common/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

remote_url=${1:?usage: published.sh <remote url> <app> <version> <platform>}
app=${2:?usage: published.sh <remote url> <app> <version> <platform>}
version=${3:?usage: published.sh <remote url> <app> <version> <platform>}
platform=${4:?usage: published.sh <remote url> <app> <version> <platform>}
command -v node >/dev/null || die "node is needed to read releases.json"

# shellcheck disable=SC2016 # the JavaScript below is meant literally
node -e '
  const [url, version, platform] = process.argv.slice(1);
  fetch(url).then(async (r) => {
    if (r.status === 404) { console.error(`${url} not found: create the app with \`apps create\` first`); process.exit(1); }
    if (!r.ok) { console.error(`${url} answered ${r.status}`); process.exit(1); }
    const body = await r.json();
    const list = Array.isArray(body) ? body : body.releases ?? [];
    const release = list.find((x) => x.version === version);
    const files = release?.files ?? [];
    console.log(files.some((f) => (f.platform ?? "mac") === platform) ? "true" : "false");
  }).catch((e) => { console.error(e.message); process.exit(1); });
' "$remote_url/$app/releases.json" "$version" "$platform"
