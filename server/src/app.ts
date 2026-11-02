import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import path from 'node:path';
import { authenticate, newToken, newTokenId, requireAdmin, requireApp, sha256 } from './auth.ts';
import type { Principal } from './auth.ts';
import type { Config } from './config.ts';
import { FEEDS, PLATFORM_NAMES, detectPlatform, feedName, downloadFile, electronLatest, liveReleases, platformReleases, releasePath, sparkleAppcast } from './feeds.ts';
import { serveReleaseFile } from './files.ts';
import { iconVersion, removeIcon, setIcon } from './icons.ts';
import { HttpError, badRequest, isObject, notFound, readJson, redirect, send, sendError, sendHtml, sendJson, sendNoContent, splitPath } from './http.ts';
import { appPage, indexPage } from './pages.ts';
import { isSparklePublicKey } from './sparkle.ts';
import { Store, isAppName } from './store.ts';
import type { AppRecord, Release } from './store.ts';
import { PLATFORMS, isPlatform } from './store.ts';
import { UPLOAD_TTL_MS, cleanupUploads, commitUpload, receiveFile, startUpload } from './uploads.ts';
import { compareVersions, isVersion } from './versions.ts';

export interface AppServer {
  server: Server;
  store: Store;
  stop(): Promise<void>;
}

export async function createAppServer(config: Config): Promise<AppServer> {
  const store = new Store(config.dataDir);
  await store.init();
  await cleanupUploads(store);
  const cleanup = setInterval(() => {
    cleanupUploads(store).catch((error) => console.error('upload cleanup failed', error));
  }, Math.min(UPLOAD_TTL_MS, 10 * 60 * 1000));
  cleanup.unref();

  const server = createServer((req, res) => {
    handle(config, store, req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        // An error before the whole body was read leaves the rest unread, so close the connection.
        sendError(res, error, req.complete ? {} : { connection: 'close' });
      } else {
        console.error(`${req.method} ${req.url} failed`, error);
        sendError(res, new HttpError(500, 'internal', 'Something went wrong'), { connection: 'close' });
      }
    });
  });
  server.requestTimeout = 2 * 60 * 60 * 1000; // large uploads over slow links
  server.headersTimeout = 60 * 1000;

  return {
    server,
    store,
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(cleanup);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function handle(config: Config, store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = url.pathname;
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  const alias = config.hostAliases.get(host);
  if (alias && !pathname.startsWith('/api/') && pathname !== '/healthz') pathname = `/${alias}${pathname}`;
  const segments = splitPath(pathname);

  if (segments[0] === 'api') return api(config, store, req, res, segments.slice(1));

  // Everything outside /api is public and read-only, so any website may read it
  // with GET or HEAD. Other methods get 405 and no CORS headers.
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') return preflight(req, res);
  if (method !== 'GET' && method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', `${method} isn't allowed here`);
  }
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-expose-headers', CORS_EXPOSED);
  if (segments.length === 1 && segments[0] === 'healthz') {
    return sendJson(res, 200, { ok: true, remote: config.remoteName });
  }
  if (segments.length === 1 && segments[0] === '') {
    const apps = await store.listApps();
    const rows = await Promise.all(apps.map(async (app) => ({ app, latest: liveReleases(await store.listReleases(app.name))[0] })));
    return sendHtml(res, 200, indexPage(config.remoteName, rows));
  }
  return publicApp(config, store, req, res, segments, url.searchParams);
}

const CORS_EXPOSED = 'Link, ETag, Content-Range, Accept-Ranges';

/** Answers a CORS preflight for the public routes. */
function preflight(req: IncomingMessage, res: ServerResponse): void {
  const requested = req.headers['access-control-request-headers'];
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    // Echo the request headers the page asks for, such as Range or If-None-Match. Nothing here reads credentials.
    ...(requested && /^[A-Za-z0-9!#$%&'*+.^_`|~, -]+$/.test(requested) ? { 'access-control-allow-headers': requested } : {}),
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
    vary: 'Access-Control-Request-Headers',
  });
  res.end();
}

/** Default and largest page size of releases.json. */
export const RELEASES_PAGE = { default: 20, max: 100 };

/** A release as the public JSON routes show it: a releases.json entry. */
function publicRelease(config: Config, app: AppRecord, release: Release) {
  const base = `${config.publicUrl}/${app.name}/`;
  return {
    version: release.version,
    build: release.build,
    publishedAt: release.publishedAt,
    // The macOS minimum, for readers from before Windows support.
    minimumSystemVersion: release.platforms.mac?.minimumSystemVersion ?? null,
    notes: release.notes,
    platforms: release.platforms,
    files: release.files.map((file) => ({ name: file.name, platform: file.platform, role: file.role, size: file.size, url: base + releasePath(release, file) })),
  };
}

/** The app's public metadata: what its page and feeds already show. */
function publicAppInfo(config: Config, app: AppRecord, releases: Release[]) {
  const base = `${config.publicUrl}/${app.name}/`;
  const platforms = PLATFORMS.filter((platform) => platformReleases(releases, platform).length > 0);
  return {
    name: app.name,
    title: app.title,
    updater: app.updater,
    platforms,
    icon: app.icon ? `${base}icon.png?v=${iconVersion(app)}` : null,
    urls: {
      page: base,
      download: `${base}download`,
      downloads: Object.fromEntries(platforms.map((platform) => [platform, `${base}download/${platform}`])),
      feeds: Object.fromEntries(platforms.map((platform) => [platform, base + feedName(app.updater, platform)])),
      latest: `${base}latest.json`,
      releases: `${base}releases.json`,
    },
  };
}

function pageSize(query: URLSearchParams): number {
  const raw = query.get('limit');
  if (raw === null) return RELEASES_PAGE.default;
  const limit = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= RELEASES_PAGE.max)) throw badRequest('invalid_limit', `limit must be 1 to ${RELEASES_PAGE.max}`);
  return limit;
}

async function publicApp(config: Config, store: Store, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams): Promise<void> {
  const [name, ...rest] = segments;
  const app = await store.getApp(name ?? '');
  if (!app) throw notFound();
  const releases = await store.listReleases(app.name);
  const route = rest.join('/');

  if (rest.length === 0) return redirect(res, 301, `/${app.name}/`);
  if (route === '') {
    const requested = query.get('platform');
    const html = appPage(config.remoteName, app, releases, {
      requested: isPlatform(requested) ? requested : null,
      visitor: detectPlatform(req.headers['user-agent']),
    });
    return sendHtml(res, 200, html, { vary: 'User-Agent' });
  }

  if (route === 'icon.png') {
    if (!app.icon) throw notFound(`${app.title} has no icon`);
    const etag = `"${app.icon.sha256.slice(0, 32)}"`;
    const headers = {
      'content-type': 'image/png',
      // Pages link to icon.png?v=<hash>, so a matching ?v can be cached for good.
      'cache-control': query.get('v') === iconVersion(app) ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const data = await fs.readFile(store.iconFile(app.name));
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'content-length': data.length, 'x-content-type-options': 'nosniff' });
      res.end();
      return;
    }
    return send(res, 200, data, headers);
  }

  if (rest[0] === 'download' && rest.length === 2) {
    const platform = rest[1];
    if (!isPlatform(platform)) throw notFound();
    const latest = platformReleases(releases, platform)[0];
    if (!latest) throw notFound(`${app.title} has no ${PLATFORM_NAMES[platform]} release yet`);
    return redirect(res, 302, `../${releasePath(latest, downloadFile(latest, platform)!)}`);
  }

  if (route === 'download') {
    const available = PLATFORMS.filter((platform) => platformReleases(releases, platform).length > 0);
    if (!available.length) throw notFound(`${app.title} has no releases yet`);
    const visitor = detectPlatform(req.headers['user-agent']);
    const headers = { vary: 'User-Agent', 'cache-control': 'no-cache' };
    // A visitor on a platform the app doesn't ship for sees the page, which says what it does ship for.
    if (visitor && !available.includes(visitor)) return send(res, 302, '', { location: './', ...headers });
    const platform = visitor ?? available[0]!;
    const latest = platformReleases(releases, platform)[0]!;
    return send(res, 302, '', { location: releasePath(latest, downloadFile(latest, platform)!), ...headers });
  }

  const feed = Object.hasOwn(FEEDS[app.updater], route) ? FEEDS[app.updater][route] : undefined;
  if (feed) {
    if (app.updater === 'sparkle') {
      return send(res, 200, sparkleAppcast(app, releases, config.publicUrl, feed), {
        'content-type': 'application/rss+xml; charset=utf-8',
        'cache-control': 'no-cache',
      });
    }
    const yml = electronLatest(releases, feed);
    if (!yml) throw notFound(`${app.title} has no ${PLATFORM_NAMES[feed]} releases yet`);
    return send(res, 200, yml, { 'content-type': 'text/yaml; charset=utf-8', 'cache-control': 'no-cache' });
  }

  const noCache = { 'cache-control': 'no-cache' };

  if (route === 'app.json') return sendJson(res, 200, publicAppInfo(config, app, releases), noCache);

  if (route === 'latest.json') {
    const requested = query.get('platform');
    if (requested !== null) {
      if (!isPlatform(requested)) throw badRequest('invalid_platform', 'platform must be mac or windows');
      const latest = platformReleases(releases, requested)[0];
      if (!latest) throw notFound(`${app.title} has no ${PLATFORM_NAMES[requested]} release yet`);
      return sendJson(res, 200, publicRelease(config, app, latest), noCache);
    }
    return sendJson(res, 200, Object.fromEntries(PLATFORMS.map((platform) => {
      const latest = platformReleases(releases, platform)[0];
      return [platform, latest ? publicRelease(config, app, latest) : null];
    })), noCache);
  }

  if (route === 'releases.json') {
    const limit = pageSize(query);
    const before = query.get('before');
    if (before !== null && !isVersion(before)) throw badRequest('invalid_before', 'before must be a version like 1.2.3');
    const live = liveReleases(releases).filter((release) => before === null || compareVersions(release.version, before) < 0);
    const page = live.slice(0, limit);
    const next = live.length > limit
      ? `${config.publicUrl}/${app.name}/releases.json?limit=${limit}&before=${page.at(-1)!.version}`
      : null;
    return sendJson(res, 200, { releases: page.map((release) => publicRelease(config, app, release)), next }, {
      ...noCache,
      ...(next ? { link: `<${next}>; rel="next"` } : {}),
    });
  }

  if (rest.length === 2 && rest[0] === 'releases' && rest[1]!.endsWith('.json')) {
    const version = rest[1]!.slice(0, -'.json'.length);
    const release = liveReleases(releases).find((candidate) => candidate.version === version);
    if (!release) throw notFound(`${app.title} has no live release ${version}`);
    return sendJson(res, 200, publicRelease(config, app, release), noCache);
  }

  if (rest.length === 3 && rest[0] === 'releases') {
    const release = releases.find((candidate) => candidate.version === rest[1]);
    const file = release?.files.find((candidate) => candidate.name === rest[2]);
    if (!release || !file) throw notFound();
    return serveReleaseFile(req, res, path.join(store.releaseDir(app.name, release.version), file.name), file);
  }

  throw notFound();
}

// API

function appView(config: Config, app: AppRecord) {
  const base = `${config.publicUrl}/${app.name}/`;
  return {
    ...app,
    urls: {
      page: base,
      download: `${base}download`,
      // The macOS feed, for readers from before Windows support.
      feed: base + feedName(app.updater, 'mac'),
      feeds: Object.fromEntries(PLATFORMS.map((platform) => [platform, base + feedName(app.updater, platform)])),
      updateBase: base,
      ...(app.icon ? { icon: `${base}icon.png?v=${iconVersion(app)}` } : {}),
    },
  };
}

function releaseView(config: Config, app: AppRecord, release: Release) {
  const base = `${config.publicUrl}/${app.name}/`;
  return { ...release, files: release.files.map((file) => ({ ...file, url: base + releasePath(release, file) })) };
}

async function requireExistingApp(store: Store, name: string | undefined): Promise<AppRecord> {
  const app = await store.getApp(name ?? '');
  if (!app) throw notFound(`No app named ${name} on this remote`);
  return app;
}

function expect(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw new HttpError(405, 'method_not_allowed', `Use ${method} here`);
}

async function api(config: Config, store: Store, req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> {
  const principal: Principal = await authenticate(req, config.adminToken, store);
  const [first, appName, second, third, fourth, fifth] = segments;
  const method = req.method ?? 'GET';

  if (first === 'whoami' && segments.length === 1) {
    expect(req, 'GET');
    return sendJson(res, 200, principal.scope === 'admin'
      ? { remote: config.remoteName, scope: 'admin' }
      : { remote: config.remoteName, scope: 'publish', app: principal.app });
  }
  if (first !== 'apps') throw notFound();

  // /api/apps
  if (segments.length === 1) {
    requireAdmin(principal);
    if (method === 'GET') {
      const apps = await store.listApps();
      return sendJson(res, 200, await Promise.all(apps.map(async (app) => {
        const latest = (await store.listReleases(app.name))[0];
        return { ...appView(config, app), latest: latest ? releaseView(config, app, latest) : null };
      })));
    }
    expect(req, 'POST');
    return sendJson(res, 201, appView(config, await createApp(store, await readJson(req))));
  }

  requireApp(principal, appName ?? '');

  // /api/apps/<app>
  if (segments.length === 2) {
    const app = await requireExistingApp(store, appName);
    if (method === 'GET') {
      const releases = await store.listReleases(app.name);
      return sendJson(res, 200, { ...appView(config, app), releases: releases.map((release) => releaseView(config, app, release)) });
    }
    expect(req, 'PATCH');
    requireAdmin(principal);
    return sendJson(res, 200, appView(config, await updateApp(store, app, await readJson(req))));
  }

  const app = await requireExistingApp(store, appName);

  // /api/apps/<app>/icon
  if (second === 'icon' && segments.length === 3) {
    if (method === 'DELETE') {
      requireAdmin(principal);
      return sendJson(res, 200, appView(config, await removeIcon(store, app)));
    }
    expect(req, 'PUT');
    return sendJson(res, 200, appView(config, await setIcon(store, app, req)));
  }

  // /api/apps/<app>/tokens[/<id>]
  if (second === 'tokens') {
    requireAdmin(principal);
    if (segments.length === 3 && method === 'GET') {
      const tokens = (await store.listTokens()).filter((token) => token.app === app.name);
      return sendJson(res, 200, tokens.map(({ id, label, createdAt }) => ({ id, label, createdAt })));
    }
    if (segments.length === 3) {
      expect(req, 'POST');
      return sendJson(res, 201, await createToken(store, app, await readJson(req)));
    }
    if (segments.length === 4) {
      expect(req, 'DELETE');
      await revokeToken(store, app, third ?? '');
      return sendNoContent(res);
    }
  }

  // /api/apps/<app>/releases/<version>/(withdraw|restore)
  if (second === 'releases' && segments.length === 5 && (fourth === 'withdraw' || fourth === 'restore')) {
    expect(req, 'POST');
    requireAdmin(principal);
    const release = await store.withLock(app.name, async () => {
      const found = await store.getRelease(app.name, third ?? '');
      if (!found) throw notFound(`No release ${third} of ${app.name}`);
      const updated = { ...found, withdrawn: fourth === 'withdraw' };
      await store.saveRelease(app.name, updated);
      return updated;
    });
    return sendJson(res, 200, releaseView(config, app, release));
  }

  // /api/apps/<app>/uploads...
  if (second === 'uploads') {
    if (segments.length === 3) {
      expect(req, 'POST');
      const state = await startUpload(store, app, await readJson(req));
      return sendJson(res, 201, { uploadId: state.id, expiresAt: state.expiresAt, version: state.version, build: state.build });
    }
    if (segments.length === 6 && fourth === 'files') {
      expect(req, 'PUT');
      await receiveFile(store, app.name, third ?? '', fifth ?? '', req);
      return sendNoContent(res);
    }
    if (segments.length === 5 && fourth === 'commit') {
      expect(req, 'POST');
      const release = await commitUpload(store, app, third ?? '');
      return sendJson(res, 201, releaseView(config, app, release));
    }
  }

  throw notFound();
}

async function createApp(store: Store, body: unknown): Promise<AppRecord> {
  if (!isObject(body)) throw badRequest('invalid_body', 'Send a JSON object');
  const { name, updater, sparklePublicKey } = body;
  if (!isAppName(name)) {
    throw badRequest('invalid_name', 'App names are 2-40 lowercase letters, digits and dashes, and not api, healthz, assets or download');
  }
  if (updater !== 'sparkle' && updater !== 'electron') throw badRequest('invalid_updater', 'updater must be sparkle or electron');
  const title = body.title ?? name;
  if (typeof title !== 'string' || !title.trim() || title.length > 100) throw badRequest('invalid_title', 'title must be 1-100 characters');
  if (updater === 'sparkle' && !isSparklePublicKey(sparklePublicKey)) {
    throw badRequest('invalid_public_key', 'Sparkle apps need sparklePublicKey: base64 of the 32-byte Ed25519 public key');
  }
  if (updater === 'electron' && sparklePublicKey !== undefined) {
    throw badRequest('invalid_public_key', 'sparklePublicKey is only for Sparkle apps');
  }
  const record: AppRecord = {
    name,
    title: title.trim(),
    updater,
    ...(updater === 'sparkle' ? { sparklePublicKey: sparklePublicKey as string } : {}),
    createdAt: new Date().toISOString(),
  };
  await store.withLock(name, () => store.createApp(record));
  return record;
}

async function updateApp(store: Store, app: AppRecord, body: unknown): Promise<AppRecord> {
  if (!isObject(body)) throw badRequest('invalid_body', 'Send a JSON object');
  const { title, sparklePublicKey } = body;
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 100)) {
    throw badRequest('invalid_title', 'title must be 1-100 characters');
  }
  if (sparklePublicKey !== undefined) {
    if (app.updater !== 'sparkle') throw badRequest('invalid_public_key', 'sparklePublicKey is only for Sparkle apps');
    if (!isSparklePublicKey(sparklePublicKey)) throw badRequest('invalid_public_key', 'sparklePublicKey must be base64 of 32 bytes');
  }
  return store.withLock(app.name, async () => {
    const current = (await store.getApp(app.name))!;
    const updated: AppRecord = {
      ...current,
      ...(typeof title === 'string' ? { title: title.trim() } : {}),
      ...(typeof sparklePublicKey === 'string' ? { sparklePublicKey } : {}),
    };
    await store.saveApp(updated);
    return updated;
  });
}

async function createToken(store: Store, app: AppRecord, body: unknown) {
  const label = isObject(body) && body.label !== undefined ? body.label : 'publish';
  if (typeof label !== 'string' || !label.trim() || label.length > 100) throw badRequest('invalid_label', 'label must be 1-100 characters');
  const token = newToken();
  const record = { id: newTokenId(), hash: sha256(token).toString('hex'), app: app.name, label: label.trim(), createdAt: new Date().toISOString() };
  await store.withLock('tokens', async () => store.saveTokens([...(await store.listTokens()), record]));
  return { id: record.id, label: record.label, createdAt: record.createdAt, token };
}

async function revokeToken(store: Store, app: AppRecord, id: string): Promise<void> {
  await store.withLock('tokens', async () => {
    const tokens = await store.listTokens();
    const remaining = tokens.filter((token) => !(token.app === app.name && token.id === id));
    if (remaining.length === tokens.length) throw notFound(`No token ${id} for ${app.name}`);
    await store.saveTokens(remaining);
  });
}
