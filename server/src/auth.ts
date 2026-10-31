import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError } from './http.ts';
import type { Store } from './store.ts';

export type Principal = { scope: 'admin' } | { scope: 'publish'; app: string; tokenId: string };

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function newToken(): string {
  return `apps_${randomBytes(32).toString('base64url')}`;
}

export function newTokenId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Works out who is calling. Tokens are compared as sha256 digests with
 * timingSafeEqual, so neither the comparison nor the token's length leaks timing.
 */
export async function authenticate(req: IncomingMessage, adminToken: string, store: Store): Promise<Principal> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) throw new HttpError(401, 'unauthorized', 'Send Authorization: Bearer <token>');
  const presented = sha256(match[1]!);

  if (timingSafeEqual(presented, sha256(adminToken))) return { scope: 'admin' };

  let found: Principal | null = null;
  for (const token of await store.listTokens()) {
    const stored = Buffer.from(token.hash, 'hex');
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      found = { scope: 'publish', app: token.app, tokenId: token.id };
    }
  }
  if (!found) throw new HttpError(401, 'unauthorized', 'Token is not valid for this remote');
  return found;
}

export function requireAdmin(principal: Principal): void {
  if (principal.scope !== 'admin') throw new HttpError(403, 'forbidden', 'This needs the admin token');
}

/** Admin, or a publish token for this app. */
export function requireApp(principal: Principal, app: string): void {
  if (principal.scope === 'publish' && principal.app !== app) {
    throw new HttpError(403, 'forbidden', `This token can only publish ${principal.app}`);
  }
}
