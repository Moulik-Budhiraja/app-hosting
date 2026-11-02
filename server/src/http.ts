import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const badRequest = (code: string, message: string) => new HttpError(400, code, message);

const SECURITY_HEADERS: OutgoingHttpHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: OutgoingHttpHeaders = {},
): void {
  const data = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-length': data.length, ...headers });
  res.end(data);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  send(res, status, JSON.stringify(body), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { ...SECURITY_HEADERS, 'cache-control': 'no-store' });
  res.end();
}

export function sendHtml(res: ServerResponse, status: number, html: string, headers: OutgoingHttpHeaders = {}): void {
  send(res, status, html, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...headers,
  });
}

export function redirect(res: ServerResponse, status: 301 | 302, location: string): void {
  send(res, status, '', { location, 'cache-control': status === 301 ? 'public, max-age=3600' : 'no-cache' });
}

export function sendError(res: ServerResponse, error: HttpError, headers: OutgoingHttpHeaders = {}): void {
  sendJson(res, error.status, { error: { code: error.code, message: error.message } }, headers);
}

/** Reads a small JSON body. An empty body reads as {}. */
export async function readJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('invalid_json', 'Body is not valid JSON');
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Splits a URL path into decoded segments, rejecting anything that could escape a directory. */
export function splitPath(pathname: string): string[] {
  const segments = pathname.split('/').slice(1);
  return segments.map((raw) => {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      throw badRequest('bad_path', 'Path is not valid');
    }
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) {
      throw badRequest('bad_path', 'Path is not valid');
    }
    return segment;
  });
}
