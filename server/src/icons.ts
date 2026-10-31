import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { HttpError, badRequest } from './http.ts';
import type { AppRecord, Store } from './store.ts';

export const MAX_ICON_SIZE = 1 << 20;
const MAX_ICON_PIXELS = 2048;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The first 12 hex digits of the icon's sha256, used as ?v= in its URL. */
export function iconVersion(app: AppRecord): string | undefined {
  return app.icon?.sha256.slice(0, 12);
}

/** Checks that `data` is a PNG with a sane size, by its signature and IHDR chunk. */
export function checkPng(data: Buffer): void {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('latin1', 12, 16) !== 'IHDR') {
    throw badRequest('invalid_icon', 'The icon must be a PNG file');
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 16 || height < 16 || width > MAX_ICON_PIXELS || height > MAX_ICON_PIXELS) {
    throw badRequest('invalid_icon', `The icon must be between 16 and ${MAX_ICON_PIXELS} pixels on each side`);
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_ICON_SIZE) throw new HttpError(413, 'too_large', 'The icon must be 1 MiB or smaller');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_ICON_SIZE) throw new HttpError(413, 'too_large', 'The icon must be 1 MiB or smaller');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Replaces the app's icon with the PNG in the request body. */
export async function setIcon(store: Store, app: AppRecord, req: IncomingMessage): Promise<AppRecord> {
  const data = await readBody(req);
  checkPng(data);
  return store.withLock(app.name, async () => {
    const file = store.iconFile(app.name);
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
    const current = (await store.getApp(app.name))!;
    const updated: AppRecord = {
      ...current,
      icon: { sha256: createHash('sha256').update(data).digest('hex'), size: data.length, updatedAt: new Date().toISOString() },
    };
    await store.saveApp(updated);
    return updated;
  });
}

export async function removeIcon(store: Store, app: AppRecord): Promise<AppRecord> {
  return store.withLock(app.name, async () => {
    const { icon: _removed, ...rest } = (await store.getApp(app.name))!;
    await store.saveApp(rest);
    await fs.rm(store.iconFile(app.name), { force: true });
    return rest;
  });
}
