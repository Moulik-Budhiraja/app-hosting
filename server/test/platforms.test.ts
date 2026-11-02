import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { formatWindows } from '../src/pages.ts';
import { ADMIN, PUBLIC_URL, api, fileEntry, publish, raw, sha256, sha512, sparkleKeys, startServer } from './helpers.ts';
import type { Harness } from './helpers.ts';

const json = async (res: Response) => (await res.json()) as any;
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

describe('macOS and Windows releases', () => {
  let h: Harness;
  const keys = sparkleKeys();

  /** Starts an upload and sends its files, without committing. Returns the upload id. */
  async function stage(app: string, release: Record<string, unknown>, files: { name: string; role: string; data: Buffer }[]): Promise<string> {
    const start = await api(h, 'POST', `/api/apps/${app}/uploads`, { ...release, files: files.map((f) => fileEntry(f.name, f.role, f.data)) });
    assert.equal(start.status, 201, await start.clone().text());
    const { uploadId } = await json(start);
    for (const file of files) {
      const put = await fetch(`${h.base}/api/apps/${app}/uploads/${uploadId}/files/${file.name}`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}` }, body: file.data });
      assert.equal(put.status, 204);
    }
    return uploadId;
  }
  const commit = (app: string, id: string) => api(h, 'POST', `/api/apps/${app}/uploads/${id}/commit`);
  const mac = (version: string, data: Buffer, extra: Record<string, unknown> = {}, name = `Native-${version}.dmg`) =>
    publish(h, 'native', { version, edSignature: keys.sign(data), ...extra }, [{ name, role: 'dmg', data }]);
  const win = (version: string, data: Buffer, extra: Record<string, unknown> = {}, name = `Native-Setup-${version}.exe`) =>
    publish(h, 'native', { version, platform: 'windows', edSignature: keys.sign(data), ...extra }, [{ name, role: 'installer', data }]);
  const code = async (res: Response) => (await json(res)).error.code;

  before(async () => {
    h = await startServer('native.example.test=native');
    for (const [name, updater] of [['native', 'sparkle'], ['legacy', 'sparkle'], ['maconly', 'sparkle'], ['winonly', 'sparkle'], ['chat', 'electron']]) {
      const body = { name, title: name[0]!.toUpperCase() + name.slice(1), updater, ...(updater === 'sparkle' ? { sparklePublicKey: keys.publicKey } : {}) };
      assert.equal((await api(h, 'POST', '/api/apps', body)).status, 201);
    }
  });
  after(async () => {
    await h.close();
  });

  test('reads release.json from before Windows support as macOS', async () => {
    const dmg = randomBytes(200);
    const dir = path.join(h.dataDir, 'apps', 'legacy', 'releases', '1.0.0');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'Legacy.dmg'), dmg);
    const old = {
      version: '1.0.0',
      build: 100000000,
      notes: 'Old notes',
      publishedAt: '2026-01-02T03:04:05.000Z',
      minimumSystemVersion: '13.0',
      withdrawn: false,
      edSignature: keys.sign(dmg),
      files: [{ name: 'Legacy.dmg', role: 'dmg', size: dmg.length, sha256: sha256(dmg), sha512: sha512(dmg) }],
    };
    await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify(old));

    const xml = await (await fetch(`${h.base}/legacy/appcast.xml`)).text();
    assert.match(xml, /<sparkle:minimumSystemVersion>13.0<\/sparkle:minimumSystemVersion>/);
    assert.ok(xml.includes(`sparkle:edSignature="${old.edSignature}"`));
    assert.match(xml, /<pubDate>Fri, 02 Jan 2026 03:04:05 GMT<\/pubDate>/);

    const list = await json(await fetch(`${h.base}/legacy/releases.json`));
    assert.deepEqual(list[0].platforms, { mac: { publishedAt: old.publishedAt, minimumSystemVersion: '13.0' } });
    assert.equal(list[0].minimumSystemVersion, '13.0');
    assert.equal(list[0].files[0].platform, 'mac');

    // Adding Windows rewrites it in the new form.
    const exe = randomBytes(300);
    const res = await publish(h, 'legacy', { version: '1.0.0', platform: 'windows', edSignature: keys.sign(exe) }, [{ name: 'Legacy-Setup.exe', role: 'installer', data: exe }]);
    assert.equal(res.status, 201, await res.clone().text());
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'release.json'), 'utf8'));
    assert.equal(stored.edSignature, undefined);
    assert.equal(stored.minimumSystemVersion, undefined);
    assert.equal(stored.notes, 'Old notes');
    assert.deepEqual(Object.keys(stored.platforms), ['mac', 'windows']);
    assert.equal(stored.files[0].edSignature, old.edSignature);
    assert.equal(stored.files[1].platform, 'windows');
  });

  test('publishes Windows to an existing release for WinSparkle', async () => {
    const dmg = randomBytes(1000);
    assert.equal((await mac('1.0.0', dmg, { notes: 'Mac notes', minimumSystemVersion: '13.0' })).status, 201);

    const exe = randomBytes(1500);
    const bad = await publish(h, 'native', { version: '1.0.0', platform: 'windows', edSignature: sparkleKeys().sign(exe) }, [{ name: 'a.exe', role: 'installer', data: exe }]);
    assert.equal(bad.status, 422);

    const res = await win('1.0.0', exe, { notes: 'Windows notes', minimumSystemVersion: '10.0.17763' });
    assert.equal(res.status, 201, await res.clone().text());
    const release = await json(res);
    assert.equal(release.build, 100000000);
    assert.equal(release.notes, 'Mac notes', 'the first notes stay');
    assert.deepEqual(release.files.map((f: any) => [f.platform, f.role]), [['mac', 'dmg'], ['windows', 'installer']]);
    assert.equal(release.files[1].edSignature, keys.sign(exe));
    assert.equal(release.files[1].url, `${PUBLIC_URL}/native/releases/1.0.0/Native-Setup-1.0.0.exe`);
    assert.equal(release.platforms.windows.minimumSystemVersion, '10.0.17763');

    const feed = await fetch(`${h.base}/native/appcast-windows.xml`);
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type') ?? '', /rss\+xml/);
    const xml = await feed.text();
    assert.match(xml, /<sparkle:version>1\.0\.0<\/sparkle:version>/);
    assert.match(xml, /<sparkle:minimumSystemVersion>10\.0\.17763<\/sparkle:minimumSystemVersion>/);
    assert.ok(xml.includes(`<enclosure url="${PUBLIC_URL}/native/releases/1.0.0/Native-Setup-1.0.0.exe" length="1500" type="application/octet-stream" sparkle:os="windows" sparkle:edSignature="${keys.sign(exe)}"/>`));
    assert.ok(!xml.includes('.dmg'));
    const macXml = await (await fetch(`${h.base}/native/appcast.xml`)).text();
    assert.ok(!macXml.includes('.exe'));
    assert.match(macXml, /<sparkle:version>100000000<\/sparkle:version>/);

    const file = await fetch(`${h.base}/native/releases/1.0.0/Native-Setup-1.0.0.exe`);
    assert.equal(file.headers.get('content-type'), 'application/vnd.microsoft.portable-executable');
    assert.equal((await fetch(`${h.base}/native/latest.yml`)).status, 404, 'no electron feeds for sparkle apps');
  });

  test('checks the rules for adding a platform', async () => {
    const data = randomBytes(64);
    assert.equal(await code(await win('1.0.0', data)), 'already_published');

    // Windows ships 1.2.0 before macOS catches up, so it can't go back to 1.1.0.
    assert.equal((await mac('1.1.0', data)).status, 201);
    assert.equal((await win('1.2.0', data)).status, 201);
    assert.equal(await code(await win('1.1.0', data)), 'version_not_newer');
    assert.equal(await code(await mac('1.1.5', data)), 'version_not_newer', 'new releases must be newer than every release');
    assert.equal((await mac('1.2.0', data)).status, 201, 'macOS can still join 1.2.0');

    assert.equal((await mac('1.3.0', data, {}, 'Native-1.3.0.exe')).status, 201);
    assert.equal(await code(await win('1.3.0', data, { build: 5 })), 'build_mismatch');
    assert.equal(await code(await win('1.3.0', data, {}, 'Native-1.3.0.exe')), 'file_exists');

    assert.equal((await api(h, 'POST', '/api/apps/native/releases/1.3.0/withdraw')).status, 200);
    assert.equal(await code(await win('1.3.0', data)), 'release_withdrawn');
    assert.equal((await api(h, 'POST', '/api/apps/native/releases/1.3.0/restore')).status, 200);
    assert.equal((await win('1.3.0', data, { build: 100300000 })).status, 201);

    // File and field rules per platform.
    const start = (body: object) => api(h, 'POST', '/api/apps/native/uploads', { version: '9.0.0', edSignature: keys.sign(data), ...body });
    assert.equal((await start({ platform: 'linux', files: [fileEntry('a.dmg', 'dmg', data)] })).status, 400);
    assert.equal((await start({ platform: 'windows', files: [fileEntry('a.zip', 'installer', data)] })).status, 400, 'installers are .exe or .msi');
    assert.equal((await start({ platform: 'windows', files: [fileEntry('a.dmg', 'dmg', data)] })).status, 400, 'no DMG on Windows');
    assert.equal((await start({ files: [fileEntry('a.exe', 'installer', data)] })).status, 400, 'no installer on macOS');
    assert.equal((await start({ platform: 'windows', minimumSystemVersion: '10.0.99999999', files: [fileEntry('a.exe', 'installer', data)] })).status, 400);
    assert.equal((await start({ minimumSystemVersion: '10.0.17763', files: [fileEntry('a.dmg', 'dmg', data)] })).status, 400, 'macOS versions are short');
    assert.equal((await start({ platform: 'windows', files: [fileEntry('a.msi', 'installer', data)] })).status, 201, 'sparkle takes an .msi');
  });

  test('both platforms can start the same new version and commit in turn', async () => {
    const dmg = randomBytes(80);
    const exe = randomBytes(90);
    const macId = await stage('native', { version: '2.0.0', edSignature: keys.sign(dmg) }, [{ name: 'Native-2.0.0.dmg', role: 'dmg', data: dmg }]);
    const winId = await stage('native', { version: '2.0.0', platform: 'windows', edSignature: keys.sign(exe) }, [{ name: 'Native-Setup-2.0.0.exe', role: 'installer', data: exe }]);
    assert.equal((await commit('native', winId)).status, 201);
    const res = await commit('native', macId);
    assert.equal(res.status, 201, await res.clone().text());
    const release = await json(res);
    assert.deepEqual(Object.keys(release.platforms).sort(), ['mac', 'windows']);
    assert.equal(release.files.length, 2);
    assert.equal(await code(await commit('native', macId)), 'already_published');
  });

  test('publishes electron for Windows with latest.yml', async () => {
    const dmg = randomBytes(100);
    const zip = randomBytes(110);
    const exe = randomBytes(120);
    const blockmap = randomBytes(12);
    assert.equal((await publish(h, 'chat', { version: '0.1.0', notes: 'Hello' }, [
      { name: 'Chat-0.1.0.dmg', role: 'dmg', data: dmg },
      { name: 'Chat-0.1.0-mac.zip', role: 'zip', data: zip },
    ])).status, 201);

    const start = (files: object[], extra: object = {}) => api(h, 'POST', '/api/apps/chat/uploads', { version: '0.1.0', platform: 'windows', files, ...extra });
    assert.equal((await start([fileEntry('Chat.msi', 'installer', exe)])).status, 400, 'electron installers are NSIS .exe');
    assert.equal((await start([fileEntry('Chat.exe', 'installer', exe), fileEntry('Other.blockmap', 'blockmap', blockmap)])).status, 400);
    assert.equal((await start([fileEntry('Chat.exe', 'installer', exe), fileEntry('Chat.zip', 'zip', exe)])).status, 400);
    assert.equal((await start([fileEntry('Chat.exe', 'installer', exe)], { edSignature: keys.sign(exe) })).status, 400);

    const res = await publish(h, 'chat', { version: '0.1.0', platform: 'windows', minimumSystemVersion: '10.0' }, [
      { name: 'Chat-Setup-0.1.0.exe', role: 'installer', data: exe },
      { name: 'Chat-Setup-0.1.0.exe.blockmap', role: 'blockmap', data: blockmap },
    ]);
    assert.equal(res.status, 201, await res.clone().text());

    const yml = await (await fetch(`${h.base}/chat/latest.yml`)).text();
    const expected = [
      'version: "0.1.0"',
      'files:',
      '  - url: "releases/0.1.0/Chat-Setup-0.1.0.exe"',
      `    sha512: "${sha512(exe)}"`,
      '    size: 120',
      '    blockMapSize: 12',
      'path: "releases/0.1.0/Chat-Setup-0.1.0.exe"',
      `sha512: "${sha512(exe)}"`,
    ].join('\n');
    assert.ok(yml.startsWith(expected), yml);
    assert.match(yml, /minimumSystemVersion: "10\.0"/);
    assert.match(yml, /releaseNotes: "Hello"/);
    const macYml = await (await fetch(`${h.base}/chat/latest-mac.yml`)).text();
    assert.match(macYml, /url: "releases\/0\.1\.0\/Chat-0\.1\.0-mac\.zip"/);
    assert.doesNotMatch(macYml, /blockMapSize/);
    assert.equal((await fetch(`${h.base}/chat/appcast-windows.xml`)).status, 404);

    const view = await json(await api(h, 'GET', '/api/apps/chat'));
    assert.deepEqual(view.urls.feeds, { mac: `${PUBLIC_URL}/chat/latest-mac.yml`, windows: `${PUBLIC_URL}/chat/latest.yml` });
    assert.equal(view.urls.feed, `${PUBLIC_URL}/chat/latest-mac.yml`);
  });

  test('sends /download to the visitor’s platform', async () => {
    const dmg = randomBytes(30);
    const exe = randomBytes(40);
    assert.equal((await publish(h, 'maconly', { version: '1.0.0', edSignature: keys.sign(dmg) }, [{ name: 'M.dmg', role: 'dmg', data: dmg }])).status, 201);
    assert.equal((await publish(h, 'winonly', { version: '1.0.0', platform: 'windows', edSignature: keys.sign(exe) }, [{ name: 'W.exe', role: 'installer', data: exe }])).status, 201);

    const go = (route: string, ua?: string) => raw(h, route, ua === undefined ? {} : { 'user-agent': ua });
    const windows = await go('/native/download', WINDOWS_UA);
    assert.equal(windows.status, 302);
    assert.equal(windows.headers.location, 'releases/2.0.0/Native-Setup-2.0.0.exe');
    assert.equal(windows.headers.vary, 'User-Agent');
    assert.equal(windows.headers['cache-control'], 'no-cache');
    assert.equal((await go('/native/download', MAC_UA)).headers.location, 'releases/2.0.0/Native-2.0.0.dmg');
    assert.equal((await go('/native/download', 'curl/8.7.1')).headers.location, 'releases/2.0.0/Native-2.0.0.dmg');
    assert.equal((await go('/native/download')).headers.location, 'releases/2.0.0/Native-2.0.0.dmg');
    assert.equal((await go('/maconly/download', WINDOWS_UA)).headers.location, './', 'nothing for Windows, so the page');
    assert.equal((await go('/winonly/download', 'curl/8.7.1')).headers.location, 'releases/1.0.0/W.exe');
    assert.equal((await go('/winonly/download', MAC_UA)).headers.location, './');

    assert.equal((await go('/native/download/windows', MAC_UA)).headers.location, '../releases/2.0.0/Native-Setup-2.0.0.exe');
    assert.equal((await go('/native/download/mac')).headers.location, '../releases/2.0.0/Native-2.0.0.dmg');
    assert.equal((await go('/maconly/download/windows')).status, 404);
    assert.equal((await go('/native/download/linux')).status, 404);
    assert.equal((await go('/native/download/mac/x')).status, 404);
    assert.equal((await go('/native/constructor')).status, 404);

    // At an alias host's root, the relative redirects land on the same files.
    const alias = { host: 'native.example.test' };
    assert.equal((await raw(h, '/download/windows', alias)).headers.location, '../releases/2.0.0/Native-Setup-2.0.0.exe');
    assert.equal((await raw(h, '/download', { ...alias, 'user-agent': WINDOWS_UA })).headers.location, 'releases/2.0.0/Native-Setup-2.0.0.exe');
    assert.equal((await raw(h, '/appcast-windows.xml', alias)).status, 200);
  });

  test('releases.json lists every platform', async () => {
    const list = await json(await fetch(`${h.base}/native/releases.json`));
    const latest = list[0];
    assert.equal(latest.version, '2.0.0');
    assert.deepEqual(Object.keys(latest.platforms).sort(), ['mac', 'windows']);
    assert.equal(latest.minimumSystemVersion, null);
    assert.deepEqual(latest.files.map((f: any) => f.platform).sort(), ['mac', 'windows']);
    assert.equal(latest.files.find((f: any) => f.platform === 'windows').url, `${PUBLIC_URL}/native/releases/2.0.0/Native-Setup-2.0.0.exe`);
    const first = list.find((r: any) => r.version === '1.0.0');
    assert.equal(first.minimumSystemVersion, '13.0');
    assert.equal(first.platforms.windows.minimumSystemVersion, '10.0.17763');
  });

  test('download pages show one platform at a time', async () => {
    const page = async (route: string, ua: string) => {
      const res = await fetch(`${h.base}${route}`, { headers: { 'user-agent': ua } });
      assert.equal(res.headers.get('vary'), 'User-Agent');
      return res.text();
    };
    const windows = await page('/native/', WINDOWS_UA);
    assert.match(windows, /href="download\/windows"[^>]*>.*Download for Windows<\/a>/);
    assert.match(windows, /<a class="also" href="\?platform=mac">Also for Mac<\/a>/);
    assert.match(windows, /href="releases\/1\.3\.0\/Native-Setup-1\.3\.0\.exe"/, 'earlier Windows versions');
    assert.doesNotMatch(windows, /\.dmg"/);

    const mac = await page('/native/', MAC_UA);
    assert.match(mac, /Download for Mac/);
    assert.match(mac, /<a class="also" href="\?platform=windows">Also for Windows<\/a>/);

    const chosen = await page('/native/?platform=mac', WINDOWS_UA);
    assert.match(chosen, /Download for Mac/);

    // The page shows the platform's own latest version, date and minimum system.
    const chat = await page('/chat/', WINDOWS_UA);
    assert.match(chat, /Version 0\.1\.0/);
    assert.match(chat, /Windows 10 or later/);

    const macOnly = await page('/maconly/?platform=windows', WINDOWS_UA);
    assert.match(macOnly, /Download for Mac/, 'falls back to what the app ships');
    assert.doesNotMatch(macOnly, /class="also"/);

    const legacy = await page('/legacy/', WINDOWS_UA);
    assert.match(legacy, /Version 1\.0\.0/);
    assert.match(legacy, /Old notes/);

    const index = await (await fetch(`${h.base}/`)).text();
    assert.match(index, /<span class="name">Native<\/span><span class="sub">Version 2\.0\.0<\/span>/);
  });

  test('formats Windows versions', () => {
    assert.equal(formatWindows('10.0'), 'Windows 10');
    assert.equal(formatWindows('10'), 'Windows 10');
    assert.equal(formatWindows('10.0.17763'), 'Windows 10 build 17763');
    assert.equal(formatWindows('10.0.22000'), 'Windows 11');
    assert.equal(formatWindows('10.0.22631'), 'Windows 11 build 22631');
    assert.equal(formatWindows('6.1'), 'Windows 6.1');
  });
});
