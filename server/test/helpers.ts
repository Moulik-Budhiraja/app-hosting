import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/app.ts';
import type { AppServer } from '../src/app.ts';
import { parseHostAliases } from '../src/config.ts';

export const ADMIN = 'admin-token-for-tests-0123456789abcdef';
export const PUBLIC_URL = 'https://apps.example.test';

export interface Harness {
  base: string;
  dataDir: string;
  app: AppServer;
  close(): Promise<void>;
}

export async function startServer(aliases = ''): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apps-server-test-'));
  const app = await createAppServer({
    publicUrl: PUBLIC_URL,
    remoteName: 'test',
    adminToken: ADMIN,
    dataDir,
    port: 0,
    hostAliases: parseHostAliases(aliases),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    app,
    close: async () => {
      await app.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function api(h: Harness, method: string, route: string, body?: unknown, token = ADMIN): Promise<Response> {
  return fetch(`${h.base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A raw request, for headers fetch won't let you set (Host) or paths it would normalize. */
export function raw(h: Harness, route: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const url = new URL(h.base);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: route, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

export function sparkleKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKey: der.subarray(der.length - 32).toString('base64'),
    sign: (data: Buffer) => sign(null, data, privateKey).toString('base64'),
  };
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export const sha512 = (data: Buffer) => createHash('sha512').update(data).digest('base64');

export function fileEntry(name: string, role: string, data: Buffer) {
  return { name, role, size: data.length, sha256: sha256(data) };
}

/** Starts an upload, sends every file and commits. Returns the commit response. */
export async function publish(
  h: Harness,
  app: string,
  release: Record<string, unknown>,
  files: { name: string; role: string; data: Buffer }[],
  token = ADMIN,
): Promise<Response> {
  const start = await api(h, 'POST', `/api/apps/${app}/uploads`, { ...release, files: files.map((f) => fileEntry(f.name, f.role, f.data)) }, token);
  if (start.status !== 201) return start;
  const { uploadId } = (await start.json()) as { uploadId: string };
  for (const file of files) {
    const put = await fetch(`${h.base}/api/apps/${app}/uploads/${uploadId}/files/${file.name}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: file.data,
    });
    if (put.status !== 204) return put;
  }
  return api(h, 'POST', `/api/apps/${app}/uploads/${uploadId}/commit`, undefined, token);
}
