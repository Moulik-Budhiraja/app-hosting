import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { api, publish, sparkleKeys, startServer } from './helpers.ts';
import type { Harness } from './helpers.ts';

const json = async (res: Response) => (await res.json()) as any;
const execFile = promisify(execFileCallback);

describe('stable and beta channels', () => {
  let h: Harness;
  const keys = sparkleKeys();
  const get = (route: string, init?: RequestInit) => fetch(`${h.base}${route}`, init);
  const text = async (route: string) => (await get(route)).text();
  const code = async (res: Response) => (await json(res)).error.code;

  const mac = (version: string, extra: Record<string, unknown> = {}) => {
    const data = randomBytes(64);
    return publish(h, 'chat', { version, ...extra }, [
      { name: `Chat-${version}.dmg`, role: 'dmg', data },
      { name: `Chat-${version}-mac.zip`, role: 'zip', data: randomBytes(64) },
    ]);
  };
  const win = (version: string) =>
    publish(h, 'chat', { version, platform: 'windows' }, [{ name: `Chat-Setup-${version}.exe`, role: 'installer', data: randomBytes(64) }]);
  const native = (version: string, platform: 'mac' | 'windows' = 'mac') => {
    const data = randomBytes(64);
    const file = platform === 'mac' ? { name: `Native-${version}.dmg`, role: 'dmg', data } : { name: `Native-Setup-${version}.exe`, role: 'installer', data };
    return publish(h, 'native', { version, platform, edSignature: keys.sign(data) }, [file]);
  };
  const feedVersion = async (route: string) => /^version: "(.+)"$/m.exec(await text(route))?.[1];
  const appcastVersions = async (route: string) =>
    [...(await text(route)).matchAll(/<sparkle:shortVersionString>(.+?)<\/sparkle:shortVersionString>/g)].map((m) => m[1]);

  before(async () => {
    h = await startServer();
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'chat', title: 'Chat', updater: 'electron' })).status, 201);
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'native', title: 'Native', updater: 'sparkle', sparklePublicKey: keys.publicKey })).status, 201);
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'early', title: 'Early', updater: 'electron' })).status, 201);
  });
  after(async () => {
    await h.close();
  });

  test('rejects versions that are neither X.Y.Z nor X.Y.Z-beta.N', async () => {
    for (const version of ['1.0.0-beta.0', '1.0.0-beta.100', '1.0.0-alpha.1', '1.0.0-rc.1', '1.0.0-beta']) {
      const res = await mac(version);
      assert.equal(res.status, 400, version);
      assert.equal(await code(res), 'invalid_version');
    }
  });

  test('a beta reaches the beta feeds and nothing a stable install reads', async () => {
    assert.equal((await mac('1.0.0', { notes: 'First' })).status, 201);
    assert.equal((await win('1.0.0')).status, 201);
    const beta = await mac('1.1.0-beta.1', { notes: 'Trying tasks' });
    assert.equal(beta.status, 201, await beta.clone().text());
    const body = await json(beta);
    assert.equal(body.channel, 'beta');
    assert.equal(body.build, 100099901);

    assert.equal(await feedVersion('/chat/latest-mac.yml'), '1.0.0');
    assert.equal(await feedVersion('/chat/beta-mac.yml'), '1.1.0-beta.1');
    assert.match(await text('/chat/beta-mac.yml'), /url: "releases\/1\.1\.0-beta\.1\/Chat-1\.1\.0-beta\.1-mac\.zip"/);
    // Windows has no beta yet, so its beta feed offers the stable release.
    assert.equal(await feedVersion('/chat/latest.yml'), '1.0.0');
    assert.equal(await feedVersion('/chat/beta.yml'), '1.0.0');

    assert.equal((await json(await get('/chat/latest.json'))).mac.version, '1.0.0');
    assert.equal((await json(await get('/chat/latest.json?platform=mac'))).version, '1.0.0');
    const latestBeta = await json(await get('/chat/latest.json?channel=beta'));
    assert.deepEqual([latestBeta.mac.version, latestBeta.mac.channel, latestBeta.windows.version], ['1.1.0-beta.1', 'beta', '1.0.0']);
    assert.equal((await json(await get('/chat/latest.json?platform=mac&channel=beta'))).version, '1.1.0-beta.1');
    assert.equal((await get('/chat/latest.json?channel=nightly')).status, 400);

    assert.deepEqual((await json(await get('/chat/releases.json'))).releases.map((r: any) => r.version), ['1.0.0']);
    assert.deepEqual((await json(await get('/chat/releases.json?channel=beta'))).releases.map((r: any) => r.version), ['1.1.0-beta.1', '1.0.0']);
    const paged = await json(await get('/chat/releases.json?channel=beta&limit=1'));
    assert.equal(paged.next, 'https://apps.example.test/chat/releases.json?limit=1&before=1.1.0-beta.1&channel=beta');
    assert.equal((await json(await get('/chat/releases/1.1.0-beta.1.json'))).channel, 'beta');
    assert.equal((await json(await get('/chat/app.json'))).urls.feeds.mac, 'https://apps.example.test/chat/latest-mac.yml');

    const stable = await get('/chat/download/mac', { redirect: 'manual' });
    assert.equal(stable.headers.get('location'), '../releases/1.0.0/Chat-1.0.0.dmg');
    const betaDownload = await get('/chat/download/mac?channel=beta', { redirect: 'manual' });
    assert.equal(betaDownload.headers.get('location'), '../releases/1.1.0-beta.1/Chat-1.1.0-beta.1.dmg');
    assert.equal((await get('/chat/releases/1.1.0-beta.1/Chat-1.1.0-beta.1.dmg')).status, 200);

    const page = await text('/chat/?platform=mac');
    assert.match(page, /Version 1\.0\.0/);
    assert.ok(!page.includes('beta'), 'the download page leaves betas out');
    assert.ok(!(await text('/')).includes('beta'));
  });

  test('a stable fix ships while a later version is in beta', async () => {
    const fix = await mac('1.0.1');
    assert.equal(fix.status, 201, await fix.clone().text());
    assert.equal(await feedVersion('/chat/latest-mac.yml'), '1.0.1');
    assert.equal(await feedVersion('/chat/beta-mac.yml'), '1.1.0-beta.1');
    // The existing release gains Windows, checked against the stable Windows releases only.
    assert.equal((await win('1.0.1')).status, 201);
    assert.equal(await feedVersion('/chat/latest.yml'), '1.0.1');
  });

  test('a beta has to be newer than every release, and a stable release than every stable one', async () => {
    const older = await mac('1.0.2-beta.1');
    assert.equal(older.status, 409);
    assert.equal(await code(older), 'version_not_newer');
    assert.equal(await code(await mac('1.0.0-beta.1')), 'version_not_newer');
    assert.equal(await code(await mac('1.0.1')), 'already_published');
    assert.equal((await mac('1.1.0-beta.2')).status, 201);
    assert.equal(await code(await mac('1.1.0-beta.1')), 'already_published');
    assert.equal(await code(await mac('1.0.0', { build: 999 })), 'already_published');
  });

  test('builds keep the order of the versions across both channels', async () => {
    // 1.1.0-beta.2 is build 100099902, and 1.0.1 is 100000100.
    assert.equal(await code(await mac('1.1.0', { build: 100000101 })), 'build_not_higher');
    assert.equal(await code(await mac('1.1.0', { build: 100099902 })), 'build_not_higher');
    assert.equal(await code(await mac('1.0.2', { build: 100099902 })), 'build_not_lower');
    assert.equal(await code(await mac('1.0.2', { build: 100000100 })), 'build_not_higher');
  });

  test('withdrawing a beta takes it off the beta feed', async () => {
    assert.equal((await api(h, 'POST', '/api/apps/chat/releases/1.1.0-beta.2/withdraw')).status, 200);
    assert.equal(await feedVersion('/chat/beta-mac.yml'), '1.1.0-beta.1');
    assert.equal((await get('/chat/releases/1.1.0-beta.2.json')).status, 404);
    assert.equal((await api(h, 'POST', '/api/apps/chat/releases/1.1.0-beta.2/restore')).status, 200);
    assert.equal(await feedVersion('/chat/beta-mac.yml'), '1.1.0-beta.2');
  });

  test('the stable release that follows its betas reaches both channels', async () => {
    assert.equal((await mac('1.1.0')).status, 201);
    assert.equal(await feedVersion('/chat/latest-mac.yml'), '1.1.0');
    assert.equal(await feedVersion('/chat/beta-mac.yml'), '1.1.0');
    assert.equal(await code(await mac('1.1.0-beta.3')), 'version_not_newer');
    assert.equal((await mac('1.1.1-beta.1')).status, 201);
  });

  test('check-feed.sh reads the feed of the version it was given', async () => {
    const run = (updater: string, platform: string, version: string) =>
      execFile('bash', [fileURLToPath(new URL('../../scripts/common/check-feed.sh', import.meta.url)), h.base, 'chat', updater, platform, version]);
    assert.match((await run('electron', 'mac', '1.1.0')).stdout, /\/chat\/latest-mac\.yml offers 1\.1\.0\n/);
    assert.match((await run('electron', 'mac', '1.1.1-beta.1')).stdout, /\/chat\/beta-mac\.yml offers 1\.1\.1-beta\.1\n/);
    assert.match((await run('electron', 'windows', '1.0.1')).stdout, /\/chat\/latest\.yml offers 1\.0\.1\n/);
    await assert.rejects(run('electron', 'linux', '1.1.0'), /no feed for electron on linux/);
  });

  test('electron feeds give each platform its own notes', async () => {
    assert.equal((await mac('1.2.0', { notes: 'For the Mac' })).status, 201);
    assert.equal((await win('1.2.0')).status, 201);
    assert.match(await text('/chat/latest-mac.yml'), /releaseNotes: "For the Mac"/);
    // Windows joined without notes, so it shows the release's.
    assert.match(await text('/chat/latest.yml'), /releaseNotes: "For the Mac"/);
    const data = randomBytes(64);
    const same = await publish(h, 'chat', { version: '1.2.1', notes: 'Shared' }, [{ name: 'Chat-1.2.1.dmg', role: 'dmg', data }, { name: 'Chat-1.2.1-mac.zip', role: 'zip', data }]);
    assert.equal(same.status, 201);
    const windows = await publish(h, 'chat', { version: '1.2.1', platform: 'windows', notes: 'For Windows' }, [{ name: 'Chat-Setup-1.2.1.exe', role: 'installer', data }]);
    assert.equal((await json(windows)).platforms.windows.notes, 'For Windows');
    assert.match(await text('/chat/latest-mac.yml'), /releaseNotes: "Shared"/);
    assert.match(await text('/chat/latest.yml'), /releaseNotes: "For Windows"/);
    assert.equal((await json(await get('/chat/latest.json?platform=windows'))).platforms.windows.notes, 'For Windows');
  });

  test('an app with only betas has nothing on the stable channel', async () => {
    const data = randomBytes(64);
    const res = await publish(h, 'early', { version: '0.1.0-beta.1' }, [
      { name: 'Early.dmg', role: 'dmg', data },
      { name: 'Early-mac.zip', role: 'zip', data },
    ]);
    assert.equal(res.status, 201);
    assert.equal((await get('/early/latest-mac.yml')).status, 404);
    assert.equal(await feedVersion('/early/beta-mac.yml'), '0.1.0-beta.1');
    assert.equal((await get('/early/download/mac')).status, 404);
    assert.match(await text('/early/'), /No releases yet/);
    assert.deepEqual((await json(await get('/early/app.json'))).platforms, []);
  });

  test('Sparkle appcasts keep betas in the -beta feeds', async () => {
    for (const platform of ['mac', 'windows'] as const) {
      assert.equal((await native('2.0.0', platform)).status, 201);
      assert.equal((await native('2.1.0-beta.1', platform)).status, 201);
    }
    assert.deepEqual(await appcastVersions('/native/appcast.xml'), ['2.0.0']);
    assert.deepEqual(await appcastVersions('/native/appcast-windows.xml'), ['2.0.0']);
    assert.deepEqual(await appcastVersions('/native/appcast-beta.xml'), ['2.1.0-beta.1', '2.0.0']);
    assert.deepEqual(await appcastVersions('/native/appcast-windows-beta.xml'), ['2.1.0-beta.1', '2.0.0']);
    // Sparkle on macOS compares builds, WinSparkle the version.
    assert.match(await text('/native/appcast-beta.xml'), /<sparkle:version>200099901<\/sparkle:version>/);
    assert.match(await text('/native/appcast-windows-beta.xml'), /<sparkle:version>2\.1\.0-beta\.1<\/sparkle:version>/);
    assert.equal((await get('/native/beta-mac.yml')).status, 404);
    assert.equal((await get('/chat/appcast-beta.xml')).status, 404);
  });
});
