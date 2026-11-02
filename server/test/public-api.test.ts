import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { ADMIN, PUBLIC_URL, api, publish, raw, sparkleKeys, startServer } from './helpers.ts';
import type { Harness } from './helpers.ts';

const json = async (res: Response) => (await res.json()) as any;
const run = promisify(execFile);
const publishedScript = fileURLToPath(new URL('../../scripts/common/published.sh', import.meta.url));

async function published(base: string, app: string, version: string, platform: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('bash', [publishedScript, base, app, version, platform]);
    return { code: 0, stdout: stdout.trim(), stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout.trim(), stderr: e.stderr };
  }
}

describe('public read-only API', () => {
  let h: Harness;
  const keys = sparkleKeys();
  // 1.0.0 to 1.11.0 for macOS, and Windows for 1.10.0 and 1.11.0.
  const versions = Array.from({ length: 12 }, (_, i) => `1.${i}.0`);

  before(async () => {
    h = await startServer();
    for (const name of ['pub', 'empty']) {
      const res = await api(h, 'POST', '/api/apps', { name, title: name === 'pub' ? 'Pub' : 'Empty', updater: 'sparkle', sparklePublicKey: keys.publicKey });
      assert.equal(res.status, 201);
    }
    for (const version of versions) {
      const dmg = randomBytes(20);
      const res = await publish(h, 'pub', { version, notes: `Notes for ${version}`, edSignature: keys.sign(dmg) }, [{ name: `Pub-${version}.dmg`, role: 'dmg', data: dmg }]);
      assert.equal(res.status, 201, await res.clone().text());
    }
    for (const version of ['1.10.0', '1.11.0']) {
      const exe = randomBytes(30);
      const res = await publish(h, 'pub', { version, platform: 'windows', edSignature: keys.sign(exe) }, [{ name: `Pub-Setup-${version}.exe`, role: 'installer', data: exe }]);
      assert.equal(res.status, 201, await res.clone().text());
    }
    assert.equal((await api(h, 'POST', '/api/apps/pub/releases/1.5.0/withdraw')).status, 200);
  });
  after(async () => {
    await h.close();
  });

  test('app.json has the public metadata only', async () => {
    const res = await fetch(`${h.base}/pub/app.json`);
    assert.equal(res.status, 200);
    const info = await json(res);
    assert.deepEqual(info, {
      name: 'pub',
      title: 'Pub',
      updater: 'sparkle',
      platforms: ['mac', 'windows'],
      icon: null,
      urls: {
        page: `${PUBLIC_URL}/pub/`,
        download: `${PUBLIC_URL}/pub/download`,
        downloads: { mac: `${PUBLIC_URL}/pub/download/mac`, windows: `${PUBLIC_URL}/pub/download/windows` },
        feeds: { mac: `${PUBLIC_URL}/pub/appcast.xml`, windows: `${PUBLIC_URL}/pub/appcast-windows.xml` },
        latest: `${PUBLIC_URL}/pub/latest.json`,
        releases: `${PUBLIC_URL}/pub/releases.json`,
      },
    });
    const empty = await json(await fetch(`${h.base}/empty/app.json`));
    assert.deepEqual(empty.platforms, []);
    assert.deepEqual(empty.urls.downloads, {});
    assert.equal((await fetch(`${h.base}/missing/app.json`)).status, 404);
  });

  test('latest.json gives the newest live release per platform', async () => {
    const both = await json(await fetch(`${h.base}/pub/latest.json`));
    assert.deepEqual(Object.keys(both), ['mac', 'windows']);
    assert.equal(both.mac.version, '1.11.0');
    assert.equal(both.windows.version, '1.11.0');
    assert.equal(both.mac.notes, 'Notes for 1.11.0');
    assert.ok(both.mac.files.every((file: any) => file.url.startsWith(`${PUBLIC_URL}/pub/releases/1.11.0/`)));

    await api(h, 'POST', '/api/apps/pub/releases/1.11.0/withdraw');
    try {
      const mac = await json(await fetch(`${h.base}/pub/latest.json?platform=mac`));
      assert.equal(mac.version, '1.10.0');
      const windows = await json(await fetch(`${h.base}/pub/latest.json?platform=windows`));
      assert.equal(windows.version, '1.10.0');
    } finally {
      await api(h, 'POST', '/api/apps/pub/releases/1.11.0/restore');
    }

    assert.deepEqual(await json(await fetch(`${h.base}/empty/latest.json`)), { mac: null, windows: null });
    assert.equal((await fetch(`${h.base}/empty/latest.json?platform=windows`)).status, 404);
    const bad = await fetch(`${h.base}/pub/latest.json?platform=linux`);
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error.code, 'invalid_platform');
  });

  test('releases/<version>.json gives one live release', async () => {
    const one = await json(await fetch(`${h.base}/pub/releases/1.10.0.json`));
    const entry = (await json(await fetch(`${h.base}/pub/releases.json?limit=100`))).releases.find((r: any) => r.version === '1.10.0');
    assert.deepEqual(one, entry);
    assert.deepEqual(one.files.map((f: any) => f.platform).sort(), ['mac', 'windows']);
    assert.equal((await fetch(`${h.base}/pub/releases/1.5.0.json`)).status, 404, 'withdrawn');
    assert.equal((await fetch(`${h.base}/pub/releases/9.9.9.json`)).status, 404);
    assert.equal((await fetch(`${h.base}/pub/releases/nope.json`)).status, 404);
    // Files keep their routes, even one named like a release.
    assert.equal((await fetch(`${h.base}/pub/releases/1.10.0/Pub-1.10.0.dmg`)).status, 200);
    assert.equal((await fetch(`${h.base}/pub/releases/1.5.0/Pub-1.5.0.dmg`)).status, 200, 'withdrawn files still serve');
  });

  test('releases.json pages newest first', async () => {
    const live = versions.filter((v) => v !== '1.5.0').reverse();

    const first = await fetch(`${h.base}/pub/releases.json`);
    const all = await json(first);
    assert.deepEqual(all.releases.map((r: any) => r.version), live, 'everything fits in the default page');
    assert.equal(all.next, null);
    assert.equal(first.headers.get('link'), null);

    const seen: string[] = [];
    let url: string | null = `${h.base}/pub/releases.json?limit=4`;
    let pages = 0;
    while (url) {
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const page = await json(res);
      assert.ok(page.releases.length <= 4);
      seen.push(...page.releases.map((r: any) => r.version));
      if (page.next) {
        assert.equal(res.headers.get('link'), `<${page.next}>; rel="next"`);
        assert.ok(page.next.startsWith(`${PUBLIC_URL}/pub/releases.json?limit=4&before=`));
      }
      url = page.next ? page.next.replace(PUBLIC_URL, h.base) : null;
      pages += 1;
    }
    assert.deepEqual(seen, live);
    assert.equal(pages, 3);

    const older = await json(await fetch(`${h.base}/pub/releases.json?before=1.3.0`));
    assert.deepEqual(older.releases.map((r: any) => r.version), ['1.2.0', '1.1.0', '1.0.0']);
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'before=1.2', 'before=latest']) {
      const res = await fetch(`${h.base}/pub/releases.json?${query}`);
      assert.equal(res.status, 400, query);
    }
  });

  test('appcasts list the newest 10 releases per platform', async () => {
    const mac = await (await fetch(`${h.base}/pub/appcast.xml`)).text();
    const macVersions = [...mac.matchAll(/<sparkle:shortVersionString>(.*?)</g)].map((m) => m[1]);
    assert.deepEqual(macVersions, ['1.11.0', '1.10.0', '1.9.0', '1.8.0', '1.7.0', '1.6.0', '1.4.0', '1.3.0', '1.2.0', '1.1.0']);
    const windows = await (await fetch(`${h.base}/pub/appcast-windows.xml`)).text();
    assert.equal([...windows.matchAll(/<item>/g)].length, 2);
  });

  test('public GETs allow any origin', async () => {
    const routes = ['/pub/app.json', '/pub/latest.json', '/pub/releases.json', '/pub/releases/1.10.0.json', '/pub/appcast.xml', '/pub/', '/', '/healthz', '/pub/releases/1.10.0/Pub-1.10.0.dmg', '/missing/app.json'];
    for (const route of routes) {
      const res = await fetch(`${h.base}${route}`, { headers: { origin: 'https://example.com' } });
      assert.equal(res.headers.get('access-control-allow-origin'), '*', route);
      assert.match(res.headers.get('access-control-expose-headers') ?? '', /Link/, route);
    }
    const download = await fetch(`${h.base}/pub/download/mac`, { redirect: 'manual' });
    assert.equal(download.status, 302);
    assert.equal(download.headers.get('access-control-allow-origin'), '*');
    const head = await raw(h, '/pub/latest.json', {}, 'HEAD');
    assert.equal(head.headers['access-control-allow-origin'], '*');

    const preflight = await raw(h, '/pub/releases.json', {
      origin: 'https://example.com',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'range, if-none-match',
    }, 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.equal(preflight.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
    assert.equal(preflight.headers['access-control-allow-headers'], 'range, if-none-match');
    assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
    const odd = await raw(h, '/pub/app.json', { 'access-control-request-headers': 'x;y="z"' }, 'OPTIONS');
    assert.equal(odd.headers['access-control-allow-headers'], undefined);

    assert.equal((await fetch(`${h.base}/pub/app.json`, { method: 'POST' })).status, 405);
  });

  test('the admin API stays without CORS', async () => {
    const authed = await api(h, 'GET', '/api/apps/pub');
    assert.equal(authed.status, 200);
    assert.equal(authed.headers.get('access-control-allow-origin'), null);
    const anonymous = await fetch(`${h.base}/api/apps`, { headers: { origin: 'https://example.com' } });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('access-control-allow-origin'), null);
    const preflight = await raw(h, '/api/apps', { origin: 'https://example.com', 'access-control-request-method': 'GET' }, 'OPTIONS');
    assert.equal(preflight.status, 401);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    assert.ok(ADMIN);
  });

  test('published.sh reads the single-release route', async () => {
    assert.deepEqual((await published(h.base, 'pub', '1.10.0', 'windows')).stdout, 'true');
    assert.deepEqual((await published(h.base, 'pub', '1.9.0', 'mac')).stdout, 'true');
    assert.deepEqual((await published(h.base, 'pub', '1.9.0', 'windows')).stdout, 'false');
    assert.deepEqual((await published(h.base, 'pub', '1.0.0', 'mac')).stdout, 'true', 'old releases beyond the first page');
    assert.deepEqual((await published(h.base, 'pub', '1.5.0', 'mac')).stdout, 'false', 'withdrawn');
    assert.deepEqual((await published(h.base, 'pub', '2.0.0', 'mac')).stdout, 'false');
    const missing = await published(h.base, 'missing', '1.0.0', 'mac');
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /apps create/);
  });
});

describe('published.sh against other servers', () => {
  // Answers only releases.json, with the whole list as an array, like the old server.
  const old = createServer((req, res) => {
    // A current server whose full list is broken, to show the script never needs it.
    if (req.url === '/new/releases/1.0.0.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '1.0.0', files: [{ name: 'n.exe', platform: 'windows' }] }));
      return;
    }
    if (req.url === '/new/app.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"name":"new"}');
      return;
    }
    if (req.url?.startsWith('/new/releases.json')) {
      res.writeHead(500);
      res.end();
      return;
    }
    if (req.url === '/old/releases.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { version: '1.2.0', files: [{ name: 'a.dmg', platform: 'mac' }] },
        { version: '1.1.0', files: [{ name: 'b.dmg' }, { name: 'b.exe', platform: 'windows' }] },
      ]));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"not_found","message":"Not found"}}');
  });
  let base = '';
  before(async () => {
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => old.close(() => resolve())));

  test('falls back to the full list', async () => {
    assert.equal((await published(base, 'old', '1.2.0', 'mac')).stdout, 'true');
    assert.equal((await published(base, 'old', '1.2.0', 'windows')).stdout, 'false');
    assert.equal((await published(base, 'old', '1.1.0', 'mac')).stdout, 'true', 'files without a platform are mac');
    assert.equal((await published(base, 'old', '1.1.0', 'windows')).stdout, 'true');
    assert.equal((await published(base, 'old', '1.3.0', 'mac')).stdout, 'false');
    assert.equal((await published(base, 'gone', '1.0.0', 'mac')).code, 1);
  });

  test("doesn't read the full list from a current server", async () => {
    assert.equal((await published(base, 'new', '1.0.0', 'windows')).stdout, 'true');
    assert.equal((await published(base, 'new', '1.0.0', 'mac')).stdout, 'false');
    assert.equal((await published(base, 'new', '2.0.0', 'mac')).stdout, 'false');
  });
});

describe('anonymous writes stay impossible', () => {
  let h: Harness;
  let before_: Map<string, string>;
  let tokenId = '';
  let uploadId = '';
  const keys = sparkleKeys();
  const ORIGIN = { origin: 'https://example.com' };

  /** Every file under the data folder with its sha256. */
  async function snapshot(): Promise<Map<string, string>> {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const { createHash } = await import('node:crypto');
    const files = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.set(path.relative(h.dataDir, full) + '/', 'dir');
          await walk(full);
        } else {
          files.set(path.relative(h.dataDir, full), createHash('sha256').update(await fs.readFile(full)).digest('hex'));
        }
      }
    };
    await walk(h.dataDir);
    return files;
  }

  const corsHeaders = (headers: Headers) => [...headers.keys()].filter((name) => name.startsWith('access-control-'));

  before(async () => {
    h = await startServer('safe.example.test=safe');
    assert.equal((await api(h, 'POST', '/api/apps', { name: 'safe', title: 'Safe', updater: 'sparkle', sparklePublicKey: keys.publicKey })).status, 201);
    const dmg = randomBytes(20);
    assert.equal((await publish(h, 'safe', { version: '1.0.0', edSignature: keys.sign(dmg) }, [{ name: 'Safe-1.0.0.dmg', role: 'dmg', data: dmg }])).status, 201);
    tokenId = (await json(await api(h, 'POST', '/api/apps/safe/tokens', { label: 'ci' }))).id;
    // A staged upload, so the upload routes have a real id to aim at.
    const exe = randomBytes(20);
    const start = await api(h, 'POST', '/api/apps/safe/uploads', { version: '1.0.0', platform: 'windows', edSignature: keys.sign(exe), files: [{ name: 'Safe-Setup.exe', role: 'installer', size: exe.length, sha256: (await import('node:crypto')).createHash('sha256').update(exe).digest('hex') }] });
    assert.equal(start.status, 201, await start.clone().text());
    uploadId = (await json(start)).uploadId;
    before_ = await snapshot();
  });
  after(async () => {
    await h.close();
  });

  const apiRoutes = (): [string, string][] => [
    ['GET', '/api/whoami'],
    ['GET', '/api/apps'],
    ['POST', '/api/apps'],
    ['GET', '/api/apps/safe'],
    ['PATCH', '/api/apps/safe'],
    ['PUT', '/api/apps/safe/icon'],
    ['DELETE', '/api/apps/safe/icon'],
    ['GET', '/api/apps/safe/tokens'],
    ['POST', '/api/apps/safe/tokens'],
    ['DELETE', `/api/apps/safe/tokens/${tokenId}`],
    ['POST', '/api/apps/safe/releases/1.0.0/withdraw'],
    ['POST', '/api/apps/safe/releases/1.0.0/restore'],
    ['POST', '/api/apps/safe/uploads'],
    ['PUT', `/api/apps/safe/uploads/${uploadId}/files/Safe-Setup.exe`],
    ['POST', `/api/apps/safe/uploads/${uploadId}/commit`],
    ['DELETE', '/api/apps/safe'],
    ['GET', '/api/nope'],
  ];
  const badAuth: Record<string, string>[] = [
    {},
    { authorization: 'Bearer wrong' },
    { authorization: `Bearer ${ADMIN}x` },
    { authorization: `Basic ${Buffer.from(`admin:${ADMIN}`).toString('base64')}` },
    { authorization: 'Bearer' },
    { authorization: ADMIN },
  ];

  test('every /api route answers 401 without a valid token, with no CORS headers', async () => {
    for (const [method, route] of apiRoutes()) {
      for (const auth of badAuth) {
        for (const suffix of ['', `?token=${ADMIN}`]) {
          const res = await fetch(`${h.base}${route}${suffix}`, {
            method,
            headers: { ...ORIGIN, ...auth, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
            ...(method === 'GET' ? {} : { body: JSON.stringify({ name: 'evil', title: 'Evil', updater: 'electron', label: 'x' }) }),
            redirect: 'manual',
          });
          const where = `${method} ${route}${suffix} ${JSON.stringify(auth)}`;
          assert.equal(res.status, 401, where);
          assert.equal((await json(res)).error.code, 'unauthorized', where);
          assert.deepEqual(corsHeaders(res.headers), [], where);
        }
      }
    }
  });

  test('/api gets no CORS preflight', async () => {
    for (const [method, route] of apiRoutes()) {
      const res = await fetch(`${h.base}${route}`, {
        method: 'OPTIONS',
        headers: { ...ORIGIN, 'access-control-request-method': method, 'access-control-request-headers': 'authorization, content-type' },
      });
      assert.equal(res.status, 401, `OPTIONS ${route}`);
      assert.deepEqual(corsHeaders(res.headers), [], `OPTIONS ${route}`);
    }
    // The host alias doesn't move /api into an app's public space either.
    const aliased = await raw(h, '/api/apps', { host: 'safe.example.test', origin: 'https://example.com' }, 'OPTIONS');
    assert.equal(aliased.status, 401);
    assert.equal(aliased.headers['access-control-allow-origin'], undefined);
  });

  const publicRoutes = [
    '/', '/healthz', '/safe', '/safe/', '/safe/?platform=windows', '/safe/app.json', '/safe/latest.json', '/safe/latest.json?platform=mac',
    '/safe/releases.json', '/safe/releases.json?limit=1', '/safe/releases/1.0.0.json', '/safe/releases/1.0.0/Safe-1.0.0.dmg',
    '/safe/appcast.xml', '/safe/appcast-windows.xml', '/safe/download', '/safe/download/mac', '/safe/icon.png',
    '/safe/uploads', `/safe/uploads/${uploadId}/commit`, '/safe/tokens', '/safe/releases/1.0.0/withdraw', '/missing/app.json', '/nope',
  ];

  test('POST, PUT, PATCH and DELETE on public paths answer 405, even with the admin token', async () => {
    for (const route of publicRoutes) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const auth of [{}, { authorization: `Bearer ${ADMIN}` }]) {
          const res = await fetch(`${h.base}${route}`, {
            method,
            headers: { ...ORIGIN, ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ version: '9.9.9', title: 'Evil' }),
            redirect: 'manual',
          });
          const where = `${method} ${route}`;
          assert.equal(res.status, 405, where);
          assert.equal((await json(res)).error.code, 'method_not_allowed', where);
          assert.deepEqual(corsHeaders(res.headers), [], where);
        }
      }
    }
    // The same through the host alias.
    const aliased = await raw(h, '/app.json', { host: 'safe.example.test' }, 'DELETE');
    assert.equal(aliased.status, 405);
  });

  test('CORS and OPTIONS are only for public GET and HEAD', async () => {
    for (const route of publicRoutes) {
      for (const method of ['GET', 'HEAD']) {
        const res = await fetch(`${h.base}${route}`, { method, headers: ORIGIN, redirect: 'manual' });
        assert.equal(res.headers.get('access-control-allow-origin'), '*', `${method} ${route}`);
      }
      const preflight = await fetch(`${h.base}${route}`, { method: 'OPTIONS', headers: { ...ORIGIN, 'access-control-request-method': 'DELETE' } });
      assert.equal(preflight.status, 204, route);
      assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS', route);
      assert.equal(preflight.headers.get('access-control-allow-credentials'), null, route);
    }
  });

  test('no public request created, changed or deleted anything', async () => {
    // Every method on every public route, with the admin token and a body, then compare the data folder.
    for (const route of publicRoutes) {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const withBody = !['GET', 'HEAD'].includes(method);
        await fetch(`${h.base}${route}`, {
          method,
          headers: { ...ORIGIN, authorization: `Bearer ${ADMIN}`, 'x-http-method-override': 'DELETE', ...(withBody ? { 'content-type': 'application/octet-stream' } : {}) },
          ...(withBody ? { body: randomBytes(64) } : {}),
          redirect: 'manual',
        });
      }
    }
    assert.deepEqual(await snapshot(), before_);
    // And the admin view agrees: same release, still live, token still there, upload still staged.
    const app = await json(await api(h, 'GET', '/api/apps/safe'));
    assert.deepEqual(app.releases.map((r: any) => [r.version, r.withdrawn]), [['1.0.0', false]]);
    assert.equal(app.title, 'Safe');
    const tokens = await json(await api(h, 'GET', '/api/apps/safe/tokens'));
    assert.deepEqual(tokens.map((t: any) => t.id), [tokenId]);
    assert.equal((await api(h, 'GET', '/api/apps')).status, 200);
    assert.equal((await json(await api(h, 'GET', '/api/apps'))).length, 1);
  });
});
