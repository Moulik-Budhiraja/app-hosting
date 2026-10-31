import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { CliError } from "./errors.js";

// DER prefixes that wrap a raw 32-byte Ed25519 seed or public key.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface SparkleKeys {
  /** Base64 of the 32-byte seed: what `generate_keys -x` exports and `sign_update --ed-key-file` reads. */
  privateKey: string;
  /** Base64 of the 32 raw public key bytes: the app's SUPublicEDKey. */
  publicKey: string;
}

export function generateSparkleKeys(): SparkleKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  return { privateKey: seed.toString("base64"), publicKey: raw.toString("base64") };
}

function decode(value: string, what: string): Buffer {
  const text = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new CliError(`The Sparkle ${what} isn't base64.`, 1, "BAD_SPARKLE_KEY");
  }
  return Buffer.from(text, "base64");
}

function privateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

function rawPublicKey(key: KeyObject): Buffer {
  return createPublicKey(key).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
}

/**
 * Reads a Sparkle private key. Accepts the 32-byte seed, or 64 bytes of seed
 * followed by its public key. Sparkle's oldest 96-byte format holds an
 * expanded key that can't be turned back into a seed, so it's rejected.
 */
export function readPrivateKey(value: string): KeyObject {
  const bytes = decode(value, "private key");
  if (bytes.length === 32) return privateKeyFromSeed(bytes);
  if (bytes.length === 64) {
    const key = privateKeyFromSeed(bytes.subarray(0, 32));
    if (!rawPublicKey(key).equals(bytes.subarray(32))) {
      throw new CliError(
        "The 64-byte Sparkle private key isn't a seed followed by its public key. Export it again with Sparkle's generate_keys -x.",
        1,
        "BAD_SPARKLE_KEY",
      );
    }
    return key;
  }
  throw new CliError(
    `The Sparkle private key is ${bytes.length} bytes; expected the 32-byte seed that generate_keys -x exports.`,
    1,
    "BAD_SPARKLE_KEY",
  );
}

export function publicKeyFor(privateKey: string): string {
  return rawPublicKey(readPrivateKey(privateKey)).toString("base64");
}

export function signArchive(data: Buffer, privateKey: string): string {
  return sign(null, data, readPrivateKey(privateKey)).toString("base64");
}

export function verifyArchive(data: Buffer, signature: string, publicKey: string): boolean {
  const raw = decode(publicKey, "public key");
  if (raw.length !== 32) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  return verify(null, data, key, decode(signature, "signature"));
}
