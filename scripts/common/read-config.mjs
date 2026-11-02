// Reads and checks an app repo's apps.json (see DESIGN.md) and prints one
// platform's settings as key=value lines, the format $GITHUB_OUTPUT takes:
//
//   node scripts/common/read-config.mjs [path/to/apps.json] [mac|windows]
//
// read-config.sh wraps it for the shell scripts; build-release.ps1 calls it
// directly. The keys are listed in read-config.sh.
import fs from 'node:fs';

const path = process.argv[2] || 'apps.json';
const platform = process.argv[3] || 'mac';
const fail = (message) => { console.error(`error: ${path}: ${message}`); process.exit(1); };
if (!['mac', 'windows'].includes(platform)) {
  console.error(`error: platform must be mac or windows, not ${platform}`);
  process.exit(1);
}
let c;
try { c = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {
  fail(e.code === 'ENOENT' ? 'not found' : `not valid JSON (${e.message})`);
}
const str = (v) => typeof v === 'string' && v.length > 0;
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const out = {};
if (!str(c.app) || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(c.app)) fail('app must match ^[a-z0-9][a-z0-9-]{1,39}$');
if (!c.remote || !str(c.remote.name) || !str(c.remote.url)) fail('remote needs a name and a url');
if (!/^https:\/\/[^/\s]+$/.test(c.remote.url.replace(/\/+$/, ''))) fail('remote.url must be an https origin, like https://apps.moulik.dev');
if (!['sparkle', 'electron'].includes(c.updater)) fail('updater must be "sparkle" or "electron"');

if (c.build !== undefined && c.builds !== undefined) fail('use builds, not both build and builds');
const builds = c.builds !== undefined ? c.builds : { mac: c.build };
if (!isObject(builds)) fail('builds must be an object with mac and/or windows');
for (const key of Object.keys(builds)) if (!['mac', 'windows'].includes(key)) fail(`builds.${key}: platforms are mac and windows`);
if (builds.mac === undefined && builds.windows === undefined) fail('builds needs mac or windows');
const b = builds[platform];
const where = c.builds !== undefined ? `builds.${platform}` : 'build';
if (b === undefined) fail(`no ${platform} build (builds.${platform} is missing)`);
if (!isObject(b)) fail(`${where} must be an object`);
if (!['native', 'electron'].includes(b.kind)) fail(`${where}.kind must be "native" or "electron"`);
if ((b.kind === 'native') !== (c.updater === 'sparkle')) fail('native builds update with sparkle and electron builds with electron');
if (!str(b.command)) fail(`${where}.command is missing`);

out.app = c.app;
out.remote_name = c.remote.name;
out.remote_url = c.remote.url.replace(/\/+$/, '');
out.updater = c.updater;
// tagPrefix is a string or a list of them. tag_prefix is the first one, for
// messages; tag_prefixes has them all, longest first, separated by spaces.
const prefixes = c.tagPrefix === undefined ? ['v'] : Array.isArray(c.tagPrefix) ? c.tagPrefix : [c.tagPrefix];
if (!prefixes.length || !prefixes.every(str)) fail('tagPrefix must be a non-empty string or a list of them');
if (prefixes.some((p) => /[\s*?[\]~^:\\]/.test(p))) fail("tagPrefix can't contain spaces or wildcard characters");
if (new Set(prefixes).size !== prefixes.length) fail('tagPrefix lists the same prefix twice');
out.tag_prefix = prefixes[0];
out.tag_prefixes = [...prefixes].sort((a, b) => b.length - a.length).join(' ');
out.kind = b.kind;
out.command = b.command;

if (platform === 'mac' && b.kind === 'native') {
  if (!str(b.app) || !b.app.replace(/\/+$/, '').endsWith('.app')) fail(`${where}.app must be the path of the built .app`);
  out.app_path = b.app.replace(/\/+$/, '');
  if (b.entitlements != null && !str(b.entitlements)) fail(`${where}.entitlements must be a path or null`);
  out.entitlements = b.entitlements ?? '';
  out.dmg_name = b.dmgName ?? out.app_path.split('/').pop().replace(/\.app$/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(out.dmg_name) || out.dmg_name.startsWith('.')) fail(`${where}.dmgName may only use letters, digits, . _ and -`);
} else if (platform === 'mac') {
  for (const k of ['dmg', 'zip']) if (!str(b[k])) fail(`${where}.${k} is required for electron builds`);
  if (b.blockmap != null && !str(b.blockmap)) fail(`${where}.blockmap must be a path or null`);
  out.dmg = b.dmg; out.zip = b.zip; out.blockmap = b.blockmap ?? '';
} else {
  if (!str(b.installer)) fail(`${where}.installer is required`);
  const extensions = b.kind === 'electron' ? ['.exe'] : ['.exe', '.msi'];
  if (!extensions.some((ext) => b.installer.toLowerCase().endsWith(ext))) {
    fail(`${where}.installer must be ${b.kind === 'electron' ? 'an .exe (NSIS)' : 'an .exe or .msi'}`);
  }
  if (b.blockmap != null && !str(b.blockmap)) fail(`${where}.blockmap must be a path or null`);
  if (b.blockmap != null && b.kind !== 'electron') fail(`${where}.blockmap is only for electron builds`);
  const min = b.minimumSystemVersion;
  if (min != null && !(str(min) && /^\d{1,2}(\.\d{1,5}){0,2}$/.test(min))) fail(`${where}.minimumSystemVersion must look like 10.0 or 10.0.17763`);
  if (b.icon != null && !(str(b.icon) && b.icon.toLowerCase().endsWith('.png'))) fail(`${where}.icon must be the path of a PNG`);
  out.installer = b.installer;
  out.blockmap = b.blockmap ?? '';
  out.minimum_system_version = min ?? '';
  out.icon = b.icon ?? '';
}
// Paths stay inside the repo; the mac build step deletes the .app before building.
for (const k of ['app_path', 'entitlements', 'dmg', 'zip', 'blockmap', 'installer', 'icon']) {
  const v = out[k];
  if (v && (/^[/\\~]/.test(v) || /^[A-Za-z]:/.test(v) || v.split(/[/\\]/).includes('..'))) fail(`${k} must be a path inside the repo`);
}
for (const [k, v] of Object.entries(out)) {
  if (/[\r\n]/.test(String(v))) fail(`${k} can't contain a newline`);
  console.log(`${k}=${v}`);
}
