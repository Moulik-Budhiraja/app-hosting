import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cleanupUploads } from '../src/uploads.ts';
import { ADMIN, PUBLIC_URL, api, fileEntry, publish, raw, sha512, sparkleKeys, startServer } from './helpers.ts';
import type { Harness } from './helpers.ts';

const json = async (res: Response) => (await res.json()) as any;

describe('apps server', () => {
  let h: Harness;
  const keys = sparkleKeys();
  const dmg1 = randomBytes(5000);
  const dmg2 = randomBytes(7000);

  before(async () => {
    h = await startServer();
  });
  after(async () => {
    await h.close();
  });

  test('healthz and auth', async () => {
    const health = await fetch(`${h.base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, remote: 'test' });

    assert.equal((await fetch(`${h.base}/api/whoami`)).status, 401);
    assert.equal((await api(h, 'GET', '/api/whoami', undefined, 'nope')).status, 401);
    assert.deepEqual(await json(await api(h, 'GET', '/api/whoami')), { remote: 'test', scope: 'admin' });
  });

  test('creates apps and validates them', async () => {
    const created = await api(h, 'POST', '/api/apps', { name: 'draw', title: 'ScreenDraw', updater: 'sparkle', sparklePublicKey: keys.publicKey });
    assert.equal(created.status, 201);
    const body = await json(created);
    assert.equal(body.urls.feed, `${PUBLIC_URL}/draw/appcast.xml`);
    assert.deepEqual(body.urls.feeds, { mac: `${PUBLIC_URL}/draw/appcast.xml`, windows: `${PUBLIC_URL}/draw/appcast-windows.xml` });

    assert.equal((await api(h, 'POST', '/api/apps', { name: 'draw', updater: 'sparkle', sparklePublicKey: keys.publicKey })).status, 409);
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'api', updater: 'electron' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'Bad Name', updater: 'electron' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'nokey', updater: 'sparkle' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'agent', title: 'Agent', updater: 'electron' })).status, 201);
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'other', updater: 'electron' })).status, 201);

    const list = await json(await api(h, 'GET', '/api/apps'));
    assert.deepEqual(list.map((app: any) => app.name), ['agent', 'draw', 'other']);
  });

  test('publish tokens only reach their own app', async () => {
    const created = await json(await api(h, 'POST', '/api/apps/draw/tokens', { label: 'ci' }));
    assert.match(created.token, /^apps_/);
    const token = created.token as string;

    assert.deepEqual(await json(await api(h, 'GET', '/api/whoami', undefined, token)), { remote: 'test', scope: 'publish', app: 'draw' });
    assert.equal((await api(h, 'GET', '/api/apps/draw', undefined, token)).status, 200);
    assert.equal((await api(h, 'GET', '/api/apps/agent', undefined, token)).status, 403);
    assert.equal((await api(h, 'POST', '/api/apps/agent/uploads', { version: '1.0.0', files: [] }, token)).status, 403);
    assert.equal((await api(h, 'GET', '/api/apps', undefined, token)).status, 403);
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'x1', updater: 'electron' }, token)).status, 403);
    assert.equal((await api(h, 'PATCH', '/api/apps/draw', { title: 'x' }, token)).status, 403);
    assert.equal((await api(h, 'GET', '/api/apps/draw/tokens', undefined, token)).status, 403);
    assert.equal((await api(h, 'POST', '/api/apps/draw/releases/1.0.0/withdraw', undefined, token)).status, 403);

    const tokens = await json(await api(h, 'GET', '/api/apps/draw/tokens'));
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].hash, undefined);

    // The stored file holds only a hash.
    const stored = await fs.readFile(path.join(h.dataDir, 'tokens.json'), 'utf8');
    assert.ok(!stored.includes(token));
  });

  test('publishes a sparkle release with a publish token', async () => {
    const { token } = await json(await api(h, 'POST', '/api/apps/draw/tokens', { label: 'ci-2' }));
    const res = await publish(
      h,
      'draw',
      { version: '1.0.0', notes: '- First **release**\n- <script>x</script>', minimumSystemVersion: '13.0', edSignature: keys.sign(dmg1) },
      [{ name: 'ScreenDraw-1.0.0.dmg', role: 'dmg', data: dmg1 }],
      token,
    );
    assert.equal(res.status, 201, await res.clone().text());
    const release = await json(res);
    assert.equal(release.build, 100000000);
    assert.equal(release.files[0].sha512, sha512(dmg1));
    assert.equal(release.files[0].url, `${PUBLIC_URL}/draw/releases/1.0.0/ScreenDraw-1.0.0.dmg`);
    assert.equal(release.files[0].platform, 'mac');
    assert.equal(release.files[0].edSignature, keys.sign(dmg1));
    assert.equal(release.platforms.mac.minimumSystemVersion, '13.0');

    const second = await publish(h, 'draw', { version: '1.1.0', notes: 'Faster', edSignature: keys.sign(dmg2) }, [
      { name: 'ScreenDraw-1.1.0.dmg', role: 'dmg', data: dmg2 },
    ]);
    assert.equal(second.status, 201);

    const feed = await fetch(`${h.base}/draw/appcast.xml`);
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type') ?? '', /rss\+xml/);
    const xml = await feed.text();
    assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>/);
    assert.match(xml, /xmlns:sparkle="http:\/\/www.andymatuschak.org\/xml-namespaces\/sparkle"/);
    assert.ok(xml.indexOf('<sparkle:shortVersionString>1.1.0') < xml.indexOf('<sparkle:shortVersionString>1.0.0'), 'newest first');
    assert.match(xml, /<sparkle:version>100100000<\/sparkle:version>/);
    assert.match(xml, /<sparkle:minimumSystemVersion>13.0<\/sparkle:minimumSystemVersion>/);
    assert.match(xml, new RegExp(`<enclosure url="${PUBLIC_URL}/draw/releases/1.0.0/ScreenDraw-1.0.0.dmg" length="5000" type="application/octet-stream" sparkle:edSignature="${keys.sign(dmg1).replace(/[+/]/g, '\\$&')}"/>`));
    assert.match(xml, /<description><!\[CDATA\[<ul><li>First <strong>release<\/strong><\/li><li>&lt;script&gt;x&lt;\/script&gt;<\/li><\/ul>\]\]><\/description>/);
    assert.match(xml, /<pubDate>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);

    // A sparkle app has no electron feed.
    assert.equal((await fetch(`${h.base}/draw/latest-mac.yml`)).status, 404);

    const file = await fetch(`${h.base}/draw/releases/1.0.0/ScreenDraw-1.0.0.dmg`);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), dmg1);
    assert.equal(file.headers.get('content-type'), 'application/x-apple-diskimage');
  });

  test('rejects a bad signature, older versions, and mismatched files', async () => {
    const other = sparkleKeys();
    const dmg = randomBytes(100);
    const bad = await publish(h, 'draw', { version: '2.0.0', edSignature: other.sign(dmg) }, [{ name: 'a.dmg', role: 'dmg', data: dmg }]);
    assert.equal(bad.status, 422);
    assert.equal((await json(bad)).error.code, 'bad_signature');

    const older = await publish(h, 'draw', { version: '1.0.5', edSignature: keys.sign(dmg) }, [{ name: 'a.dmg', role: 'dmg', data: dmg }]);
    assert.equal(older.status, 409);
    assert.equal((await json(older)).error.code, 'version_not_newer');
    const same = await publish(h, 'draw', { version: '1.1.0', edSignature: keys.sign(dmg) }, [{ name: 'a.dmg', role: 'dmg', data: dmg }]);
    assert.equal(same.status, 409);
    const lowBuild = await publish(h, 'draw', { version: '1.2.0', build: 5, edSignature: keys.sign(dmg) }, [{ name: 'a.dmg', role: 'dmg', data: dmg }]);
    assert.equal((await json(lowBuild)).error.code, 'build_not_higher');

    const start = await json(await api(h, 'POST', '/api/apps/draw/uploads', { version: '2.0.0', edSignature: keys.sign(dmg), files: [fileEntry('b.dmg', 'dmg', dmg)] }));
    const put = (body: Buffer) =>
      fetch(`${h.base}/api/apps/draw/uploads/${start.uploadId}/files/b.dmg`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}` }, body });
    const tooShort = await put(dmg.subarray(0, 50));
    assert.equal(tooShort.status, 400);
    assert.equal((await json(tooShort)).error.code, 'size_mismatch');
    const wrongBytes = await put(randomBytes(100));
    assert.equal((await json(wrongBytes)).error.code, 'sha256_mismatch');
    assert.equal((await api(h, 'POST', `/api/apps/draw/uploads/${start.uploadId}/commit`)).status, 409, 'nothing uploaded yet');
    const undeclared = await fetch(`${h.base}/api/apps/draw/uploads/${start.uploadId}/files/c.dmg`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}` }, body: dmg });
    assert.equal(undeclared.status, 404);

    assert.equal((await put(dmg)).status, 204);
    assert.equal((await api(h, 'POST', `/api/apps/draw/uploads/${start.uploadId}/commit`)).status, 201);
    const again = await api(h, 'POST', `/api/apps/draw/uploads/${start.uploadId}/commit`);
    assert.equal(again.status, 409);
    assert.equal((await json(again)).error.code, 'already_published');
  });

  test('validates upload declarations', async () => {
    const dmg = randomBytes(10);
    const start = (body: object) => api(h, 'POST', '/api/apps/agent/uploads', body);
    const zip = randomBytes(20);
    assert.equal((await start({ version: '1.0', files: [fileEntry('a.dmg', 'dmg', dmg), fileEntry('a.zip', 'zip', zip)] })).status, 400);
    assert.equal((await start({ version: '1.0.0', files: [fileEntry('a.dmg', 'dmg', dmg)] })).status, 400, 'electron needs a zip');
    assert.equal((await start({ version: '1.0.0', files: [fileEntry('../a.dmg', 'dmg', dmg), fileEntry('a.zip', 'zip', zip)] })).status, 400);
    assert.equal((await start({ version: '1.0.0', files: [fileEntry('.a.dmg', 'dmg', dmg), fileEntry('a.zip', 'zip', zip)] })).status, 400);
    assert.equal((await start({ version: '1.0.0', files: [fileEntry('release.json', 'dmg', dmg), fileEntry('a.zip', 'zip', zip)] })).status, 400);
    assert.equal(
      (await start({ version: '1.0.0', files: [fileEntry('a.dmg', 'dmg', dmg), fileEntry('a.zip', 'zip', zip), fileEntry('b.blockmap', 'blockmap', zip)] })).status,
      400,
      'blockmap must be named after the zip',
    );
    assert.equal((await start({ version: '1.0.0', edSignature: 'x', files: [fileEntry('a.dmg', 'dmg', dmg), fileEntry('a.zip', 'zip', zip)] })).status, 400);
    assert.equal((await api(h, 'POST', '/api/apps/draw/uploads', { version: '9.0.0', files: [fileEntry('a.dmg', 'dmg', dmg)] })).status, 400, 'sparkle needs a signature');
  });

  test('publishes electron releases with latest-mac.yml', async () => {
    const dmg = randomBytes(300);
    const zip = randomBytes(400);
    const blockmap = randomBytes(30);
    const res = await publish(h, 'agent', { version: '0.4.2', notes: 'Line one\n"quoted": yes' }, [
      { name: 'Agent.dmg', role: 'dmg', data: dmg },
      { name: 'Agent-0.4.2-mac.zip', role: 'zip', data: zip },
      { name: 'Agent-0.4.2-mac.zip.blockmap', role: 'blockmap', data: blockmap },
    ]);
    assert.equal(res.status, 201, await res.clone().text());

    const feed = await fetch(`${h.base}/agent/latest-mac.yml`);
    assert.equal(feed.status, 200);
    const yml = await feed.text();
    const expectedStart = [
      'version: "0.4.2"',
      'files:',
      '  - url: "releases/0.4.2/Agent-0.4.2-mac.zip"',
      `    sha512: "${sha512(zip)}"`,
      '    size: 400',
      '    blockMapSize: 30',
      'path: "releases/0.4.2/Agent-0.4.2-mac.zip"',
      `sha512: "${sha512(zip)}"`,
    ].join('\n');
    assert.ok(yml.startsWith(expectedStart), yml);
    assert.match(yml, /releaseDate: "\d{4}-\d{2}-\d{2}T[^"]+Z"/);
    assert.match(yml, /releaseNotes: "Line one\\n\\"quoted\\": yes"/);
    assert.equal((await fetch(`${h.base}/agent/appcast.xml`)).status, 404);
    assert.equal((await fetch(`${h.base}/agent/releases/0.4.2/Agent-0.4.2-mac.zip.blockmap`)).status, 200);
  });

  test('withdraw and restore change feeds and downloads', async () => {
    const download = async () => (await fetch(`${h.base}/draw/download`, { redirect: 'manual' })).headers.get('location');
    assert.equal(await download(), 'releases/2.0.0/b.dmg');

    const withdrawn = await api(h, 'POST', '/api/apps/draw/releases/2.0.0/withdraw');
    assert.equal(withdrawn.status, 200);
    assert.equal((await json(withdrawn)).withdrawn, true);
    assert.equal(await download(), 'releases/1.1.0/ScreenDraw-1.1.0.dmg');
    assert.ok(!(await (await fetch(`${h.base}/draw/appcast.xml`)).text()).includes('2.0.0'));
    assert.ok(!(await (await fetch(`${h.base}/draw/`)).text()).includes('Version 2.0.0'));
    assert.equal((await fetch(`${h.base}/draw/releases/2.0.0/b.dmg`)).status, 200, 'withdrawn files still serve');
    const publicList = await json(await fetch(`${h.base}/draw/releases.json`));
    assert.deepEqual(publicList.map((r: any) => r.version), ['1.1.0', '1.0.0']);

    // A withdrawn version still blocks reuse of its number.
    const dmg = randomBytes(10);
    assert.equal((await publish(h, 'draw', { version: '2.0.0', edSignature: keys.sign(dmg) }, [{ name: 'c.dmg', role: 'dmg', data: dmg }])).status, 409);

    await api(h, 'POST', '/api/apps/agent/releases/0.4.2/withdraw');
    assert.equal((await fetch(`${h.base}/agent/latest-mac.yml`)).status, 404);
    await api(h, 'POST', '/api/apps/agent/releases/0.4.2/restore');
    assert.equal((await fetch(`${h.base}/agent/latest-mac.yml`)).status, 200);

    assert.equal((await api(h, 'POST', '/api/apps/draw/releases/2.0.0/restore')).status, 200);
    assert.equal(await download(), 'releases/2.0.0/b.dmg');
    assert.equal((await api(h, 'POST', '/api/apps/draw/releases/9.9.9/withdraw')).status, 404);
  });

  test('pages', async () => {
    const page = await fetch(`${h.base}/draw/`);
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src 'self' data:/);
    const html = await page.text();
    assert.match(html, /<h1>ScreenDraw<\/h1>/);
    assert.match(html, /<p class="meta">Version 2\.0\.0 · [A-Z][a-z]+ \d{1,2}, \d{4}<\/p>/);
    assert.match(html, /href="download\/mac"/);
    assert.match(html, /Earlier versions/);
    assert.match(html, /class="tile"[^>]*>S</, 'no icon yet, so the initial stands in');
    assert.doesNotMatch(html, /text-transform:uppercase/);

    const redirect = await fetch(`${h.base}/draw`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/draw/');

    const index = await (await fetch(`${h.base}/`)).text();
    assert.match(index, /<h1>Apps<\/h1>/);
    assert.match(index, /href="draw\/">.*<span class="name">ScreenDraw<\/span><span class="sub">Version 2\.0\.0<\/span>/);
    assert.match(index, /<span class="name">other<\/span><span class="sub">No releases yet<\/span>/);
    const other = await (await fetch(`${h.base}/other/`)).text();
    assert.match(other, /No releases yet/);
    assert.doesNotMatch(other, /href="download/);
    assert.equal((await fetch(`${h.base}/missing/`)).status, 404);
    assert.equal((await fetch(`${h.base}/other/download`)).status, 404, 'no releases yet');
  });

  test('icons', async () => {
    const png = (size: number, extra = 0) => {
      const data = Buffer.alloc(33 + extra);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
      data.writeUInt32BE(13, 8);
      data.write('IHDR', 12, 'latin1');
      data.writeUInt32BE(size, 16);
      data.writeUInt32BE(size, 20);
      return data;
    };
    const put = (body: Buffer, token = ADMIN, app = 'draw') =>
      fetch(`${h.base}/api/apps/${app}/icon`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' }, body });

    assert.equal((await fetch(`${h.base}/draw/icon.png`)).status, 404);
    assert.equal((await put(Buffer.from('<svg></svg>'))).status, 400);
    assert.equal((await put(png(8))).status, 400, 'too small');
    assert.equal((await put(png(4096))).status, 400, 'too large in pixels');
    // The server refuses an oversized body from its Content-Length and closes the
    // connection, so the client may see the 413 or a reset while still sending.
    const tooBig = await put(png(256, 2 << 20)).then((res) => res.status, () => 'reset');
    assert.ok(tooBig === 413 || tooBig === 'reset', `got ${tooBig}`);

    const { token } = await json(await api(h, 'POST', '/api/apps/draw/tokens', { label: 'icon' }));
    assert.equal((await put(png(256), token, 'agent')).status, 403);
    const icon = png(256);
    const set = await put(icon, token);
    assert.equal(set.status, 200);
    const view = await json(set);
    const version = view.icon.sha256.slice(0, 12);
    assert.equal(view.urls.icon, `${PUBLIC_URL}/draw/icon.png?v=${version}`);

    const served = await fetch(`${h.base}/draw/icon.png?v=${version}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.match(served.headers.get('cache-control') ?? '', /immutable/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), icon);
    const unversioned = await fetch(`${h.base}/draw/icon.png`);
    assert.equal(unversioned.headers.get('cache-control'), 'no-cache');
    const etag = unversioned.headers.get('etag') ?? '';
    assert.equal((await raw(h, '/draw/icon.png', { 'if-none-match': etag })).status, 304);
    assert.equal((await raw(h, '/draw/icon.png', {}, 'HEAD')).status, 200);

    const page = await (await fetch(`${h.base}/draw/`)).text();
    assert.match(page, new RegExp(`<img src="icon\\.png\\?v=${version}" alt="">`));
    const index = await (await fetch(`${h.base}/`)).text();
    assert.match(index, new RegExp(`<img src="draw/icon\\.png\\?v=${version}" alt="">`));

    assert.equal((await api(h, 'DELETE', '/api/apps/draw/icon', undefined, token)).status, 403);
    const removed = await api(h, 'DELETE', '/api/apps/draw/icon');
    assert.equal(removed.status, 200);
    assert.equal((await json(removed)).icon, undefined);
    assert.equal((await fetch(`${h.base}/draw/icon.png`)).status, 404);
    assert.match(await (await fetch(`${h.base}/draw/`)).text(), /class="tile"/);
  });

  test('range and conditional requests', async () => {
    const route = '/draw/releases/1.0.0/ScreenDraw-1.0.0.dmg';
    const partial = await raw(h, route, { range: 'bytes=10-19' });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-range'], 'bytes 10-19/5000');
    assert.deepEqual(partial.body, dmg1.subarray(10, 20));

    const suffix = await raw(h, route, { range: 'bytes=-5' });
    assert.deepEqual(suffix.body, dmg1.subarray(4995));
    const open = await raw(h, route, { range: 'bytes=4990-' });
    assert.equal(open.body.length, 10);

    const unsatisfiable = await raw(h, route, { range: 'bytes=6000-' });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers['content-range'], 'bytes */5000');

    const full = await raw(h, route);
    const etag = full.headers.etag as string;
    assert.equal((await raw(h, route, { 'if-none-match': etag })).status, 304);
    assert.equal((await raw(h, route, { range: 'bytes=0-0', 'if-range': '"stale"' })).status, 200);

    const head = await raw(h, route, {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '5000');
    assert.equal(head.body.length, 0);
  });

  test('path traversal and odd paths are rejected', async () => {
    for (const route of ['/draw/releases/1.0.0/..%2F..%2Fapp.json', '/draw/releases/..%2F1.0.0/x', '/%2e%2e/tokens.json', '/draw/releases/1.0.0/release.json', '/draw/app.json', '/draw/%00']) {
      const res = await raw(h, route);
      assert.ok(res.status === 400 || res.status === 404, `${route} → ${res.status}`);
      assert.ok(!res.body.toString().includes('sparklePublicKey'), route);
    }
    const dotdot = await raw(h, '/api/apps/draw/uploads/../../tokens', { authorization: `Bearer ${ADMIN}` });
    assert.ok(dotdot.status === 400 || dotdot.status === 404);
    assert.equal((await fetch(`${h.base}/draw/`, { method: 'POST' })).status, 405);
  });

  test('cleans up expired uploads', async () => {
    const dmg = randomBytes(10);
    const start = await json(await api(h, 'POST', '/api/apps/draw/uploads', { version: '3.0.0', edSignature: keys.sign(dmg), files: [fileEntry('d.dmg', 'dmg', dmg)] }));
    const store = h.app.store;
    assert.ok((await fs.readdir(store.uploadsDir())).includes(start.uploadId));
    await cleanupUploads(store, Date.now() + 7 * 60 * 60 * 1000);
    assert.ok(!(await fs.readdir(store.uploadsDir())).includes(start.uploadId));
    const late = await fetch(`${h.base}/api/apps/draw/uploads/${start.uploadId}/files/d.dmg`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}` }, body: dmg });
    assert.equal(late.status, 404);
  });

  test('revoked tokens stop working', async () => {
    const created = await json(await api(h, 'POST', '/api/apps/other/tokens', { label: 'temp' }));
    assert.equal((await api(h, 'GET', '/api/whoami', undefined, created.token)).status, 200);
    assert.equal((await api(h, 'DELETE', `/api/apps/other/tokens/${created.id}`)).status, 204);
    assert.equal((await api(h, 'GET', '/api/whoami', undefined, created.token)).status, 401);
    assert.equal((await api(h, 'DELETE', `/api/apps/other/tokens/${created.id}`)).status, 404);
  });
});

describe('host aliases', () => {
  let h: Harness;
  before(async () => {
    h = await startServer('notes.example.test=notes');
    const keys = sparkleKeys();
    await api(h, 'POST', '/api/apps', { name: 'notes', title: 'Notes', updater: 'sparkle', sparklePublicKey: keys.publicKey });
    const dmg = randomBytes(64);
    const res = await publish(h, 'notes', { version: '0.1.0', edSignature: keys.sign(dmg) }, [{ name: 'Notes.dmg', role: 'dmg', data: dmg }]);
    assert.equal(res.status, 201);
  });
  after(async () => {
    await h.close();
  });

  test('serves the app at the alias root', async () => {
    const host = { host: 'notes.example.test' };
    const feed = await raw(h, '/appcast.xml', host);
    assert.equal(feed.status, 200);
    assert.match(feed.body.toString(), /<enclosure url="https:\/\/apps.example.test\/notes\/releases\/0.1.0\/Notes.dmg"/);

    const page = await raw(h, '/', host);
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /<h1>Notes<\/h1>/);

    const download = await raw(h, '/download', host);
    assert.equal(download.status, 302);
    assert.equal(download.headers.location, 'releases/0.1.0/Notes.dmg');
    assert.equal((await raw(h, '/releases/0.1.0/Notes.dmg', host)).status, 200);

    const portHost = await raw(h, '/appcast.xml', { host: 'NOTES.example.test:443' });
    assert.equal(portHost.status, 200);

    const apiOnAlias = await raw(h, '/api/whoami', { ...host, authorization: `Bearer ${ADMIN}` });
    assert.equal(apiOnAlias.status, 200);
    assert.equal((await raw(h, '/healthz', host)).status, 200);

    // Other hosts are unaffected.
    assert.equal((await raw(h, '/appcast.xml', { host: 'apps.example.test' })).status, 404);
  });
});
