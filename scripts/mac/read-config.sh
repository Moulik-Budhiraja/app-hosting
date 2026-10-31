#!/usr/bin/env bash
# Reads and checks an app repo's apps.json (see DESIGN.md) and prints its
# settings as key=value lines, the format $GITHUB_OUTPUT takes:
#
#   scripts/mac/read-config.sh [path/to/apps.json] >> "$GITHUB_OUTPUT"
#
# Keys: app, remote_name, remote_url, updater, tag_prefix, kind, command, and
# for native builds app_path, entitlements, dmg_name; for electron builds dmg,
# zip, blockmap (these may still contain {version}). Needs node.
set -euo pipefail
# shellcheck source=scripts/mac/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

config=${1:-apps.json}
[[ -f $config ]] || die "$config not found"
command -v node >/dev/null || die "node is needed to read $config"

node - "$config" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const fail = (message) => { console.error(`error: ${path}: ${message}`); process.exit(1); };
let c;
try { c = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { fail(`not valid JSON (${e.message})`); }
const str = (v) => typeof v === 'string' && v.length > 0;
const out = {};
if (!str(c.app) || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(c.app)) fail('app must match ^[a-z0-9][a-z0-9-]{1,39}$');
if (!c.remote || !str(c.remote.name) || !str(c.remote.url)) fail('remote needs a name and a url');
if (!/^https:\/\/[^/\s]+$/.test(c.remote.url.replace(/\/+$/, ''))) fail('remote.url must be an https origin, like https://apps.moulik.dev');
if (!['sparkle', 'electron'].includes(c.updater)) fail('updater must be "sparkle" or "electron"');
const b = c.build;
if (!b || typeof b !== 'object') fail('build is missing');
if (!['native', 'electron'].includes(b.kind)) fail('build.kind must be "native" or "electron"');
if ((b.kind === 'native') !== (c.updater === 'sparkle')) fail('native builds update with sparkle and electron builds with electron');
if (!str(b.command)) fail('build.command is missing');
out.app = c.app;
out.remote_name = c.remote.name;
out.remote_url = c.remote.url.replace(/\/+$/, '');
out.updater = c.updater;
out.tag_prefix = c.tagPrefix ?? 'v';
if (!str(out.tag_prefix)) fail('tagPrefix must be a non-empty string');
out.kind = b.kind;
out.command = b.command;
if (b.kind === 'native') {
  if (!str(b.app) || !b.app.replace(/\/+$/, '').endsWith('.app')) fail('build.app must be the path of the built .app');
  out.app_path = b.app.replace(/\/+$/, '');
  if (b.entitlements != null && !str(b.entitlements)) fail('build.entitlements must be a path or null');
  out.entitlements = b.entitlements ?? '';
  out.dmg_name = b.dmgName ?? out.app_path.split('/').pop().replace(/\.app$/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(out.dmg_name) || out.dmg_name.startsWith('.')) fail('build.dmgName may only use letters, digits, . _ and -');
} else {
  for (const k of ['dmg', 'zip']) if (!str(b[k])) fail(`build.${k} is required for electron builds`);
  if (b.blockmap != null && !str(b.blockmap)) fail('build.blockmap must be a path or null');
  out.dmg = b.dmg; out.zip = b.zip; out.blockmap = b.blockmap ?? '';
}
// Paths stay inside the repo; the build step deletes build.app before building.
for (const k of ['app_path', 'entitlements', 'dmg', 'zip', 'blockmap']) {
  const v = out[k];
  if (v && (v.startsWith('/') || v.startsWith('~') || v.split('/').includes('..'))) fail(`${k} must be a path inside the repo`);
}
for (const [k, v] of Object.entries(out)) {
  if (/[\r\n]/.test(String(v))) fail(`${k} can't contain a newline`);
  console.log(`${k}=${v}`);
}
NODE
