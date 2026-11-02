#!/usr/bin/env bash
# Prints true if a remote has a live release of an app's version with files for
# a platform, and false if not. Files without a platform are mac files, from
# releases published before Windows support.
#
#   scripts/common/published.sh <remote url> <app> <version> <mac|windows>
#
# Reads /<app>/releases/<version>.json, which is 404 for a missing or withdrawn
# release, and /<app>/app.json to tell that apart from a missing app. Servers
# from before those routes only have the full /<app>/releases.json list, so it
# falls back to that. Fails if the app doesn't exist on the remote. Needs node.
set -euo pipefail
# shellcheck source=scripts/common/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

remote_url=${1:?usage: published.sh <remote url> <app> <version> <platform>}
app=${2:?usage: published.sh <remote url> <app> <version> <platform>}
version=${3:?usage: published.sh <remote url> <app> <version> <platform>}
platform=${4:?usage: published.sh <remote url> <app> <version> <platform>}
command -v node >/dev/null || die "node is needed to read the release"

# shellcheck disable=SC2016 # the JavaScript below is meant literally
node -e '
  const [base, version, platform] = process.argv.slice(1);
  const has = (release) => (release?.files ?? []).some((f) => (f.platform ?? "mac") === platform);
  const get = async (url) => {
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (!r.ok) { console.error(`${url} answered ${r.status}`); process.exit(1); }
    return r.json();
  };
  (async () => {
    const release = await get(`${base}/releases/${version}.json`);
    if (release) return has(release);
    if (await get(`${base}/app.json`)) return false;
    // A server from before the single-release route.
    const body = await get(`${base}/releases.json`);
    if (!body) { console.error(`${base} not found: create the app with \`apps create\` first`); process.exit(1); }
    const list = Array.isArray(body) ? body : body.releases ?? [];
    return has(list.find((x) => x.version === version));
  })().then((found) => console.log(found ? "true" : "false"), (e) => { console.error(e.message); process.exit(1); });
' "$remote_url/$app" "$version" "$platform"
