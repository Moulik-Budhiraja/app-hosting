import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { send } from './http.ts';
import type { ReleaseFile } from './store.ts';

const TYPES: Record<string, string> = {
  dmg: 'application/x-apple-diskimage',
  zip: 'application/zip',
  blockmap: 'application/octet-stream',
};

/** Parses a single-range Range header. Returns null for a range this server won't honor. */
export function parseRange(header: string, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Serves an immutable release file with ETag, conditional requests and byte ranges. */
export async function serveReleaseFile(req: IncomingMessage, res: ServerResponse, diskPath: string, file: ReleaseFile): Promise<void> {
  const etag = `"${file.sha256.slice(0, 32)}"`;
  const headers = {
    'content-type': TYPES[file.role] ?? 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    etag,
    'content-disposition': `attachment; filename="${file.name}"`,
    'x-content-type-options': 'nosniff',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  let range: ReturnType<typeof parseRange> = null;
  const rangeHeader = req.headers.range;
  const ifRange = req.headers['if-range'];
  if (rangeHeader && (!ifRange || ifRange === etag)) range = parseRange(rangeHeader, file.size);

  if (range === 'unsatisfiable') {
    send(res, 416, '', { ...headers, 'content-range': `bytes */${file.size}` });
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'content-length': end - start + 1,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${file.size}` } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(createReadStream(diskPath, { start, end }), res);
}
