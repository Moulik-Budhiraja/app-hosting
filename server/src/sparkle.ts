import { createPublicKey, verify } from 'node:crypto';

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64_RE.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value ? decoded : null;
}

/** A Sparkle public key: base64 of the 32 raw Ed25519 bytes (SUPublicEDKey). */
export function isSparklePublicKey(value: unknown): value is string {
  return decodeBase64(value, 32) !== null;
}

/** A Sparkle signature: base64 of a 64-byte Ed25519 signature (sparkle:edSignature). */
export function isSparkleSignature(value: unknown): value is string {
  return decodeBase64(value, 64) !== null;
}

/** Sparkle signs the archive's raw bytes with Ed25519. */
export function verifySparkleSignature(publicKey: string, data: Buffer, signature: string): boolean {
  const raw = decodeBase64(publicKey, 32);
  const sig = decodeBase64(signature, 64);
  if (!raw || !sig) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  return verify(null, data, key, sig);
}
