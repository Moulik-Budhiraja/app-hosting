import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultBuildSection, expandPath, validateAppFile } from "../src/appfile.js";
import { feedVersion } from "../src/commands/manage.js";
import { loadConfig, normalizeUrl, saveConfig } from "../src/config.js";
import { generateSparkleKeys, publicKeyFor, readPrivateKey, signArchive, verifyArchive } from "../src/sparkle.js";
import { compareVersions, defaultBuild, parseVersion } from "../src/version.js";

test("default build numbers follow hobola's scheme", () => {
  assert.equal(defaultBuild("1.2.3"), 100200300);
  assert.equal(defaultBuild("0.1.17"), 100_000 + 1700);
  assert.equal(defaultBuild("10.0.0"), 1_000_000_000);
  assert.throws(() => defaultBuild("1.1000.0"), /below 1000/);
  assert.throws(() => parseVersion("1.2"), /isn't a version/);
  assert.throws(() => parseVersion("v1.2.3"), /isn't a version/);
  assert.throws(() => parseVersion("01.2.3"), /isn't a version/);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

const nativeFile = {
  app: "screen-draw",
  remote: { name: "moulik", url: "https://apps.moulik.dev/" },
  updater: "sparkle",
  build: { kind: "native", command: "./scripts/build.sh", app: "build/ScreenDraw.app", entitlements: null },
};

test("apps.json validation fills defaults and normalizes", () => {
  const file = validateAppFile(nativeFile);
  assert.equal(file.tagPrefix, "v");
  assert.equal(file.remote.url, "https://apps.moulik.dev");
  assert.deepEqual(file.build, {
    kind: "native", command: "./scripts/build.sh", app: "build/ScreenDraw.app", entitlements: null, dmgName: "ScreenDraw",
  });
});

test("apps.json validation rejects bad files with useful messages", () => {
  assert.throws(() => validateAppFile({ ...nativeFile, app: "API" }), /isn't a valid app name/);
  assert.throws(() => validateAppFile({ ...nativeFile, app: "download" }), /reserved/);
  assert.throws(() => validateAppFile({ ...nativeFile, updater: "squirrel" }), /updater must be/);
  assert.throws(() => validateAppFile({ ...nativeFile, updater: "electron" }), /needs updater "sparkle"/);
  assert.throws(() => validateAppFile({ ...nativeFile, remote: { name: "moulik", url: "ftp://x" } }), /https/);
  assert.throws(() => validateAppFile({ ...nativeFile, tagPrefix: "v*" }), /tagPrefix/);
  assert.throws(() => validateAppFile({ ...nativeFile, build: { ...nativeFile.build, app: "build/ScreenDraw" } }), /\.app bundle/);
  assert.throws(() => validateAppFile({ ...nativeFile, build: { kind: "electron", command: "x", dmg: "a", zip: "b" } }), /needs updater "electron"/);
  assert.throws(() => validateAppFile([]), /JSON object/);
});

test("electron apps.json and the {version} placeholder", () => {
  const build = defaultBuildSection("proactive-agent", "Proactive Agent", "electron");
  const file = validateAppFile({ app: "proactive-agent", remote: { name: "proletic", url: "https://apps.proletic.co" }, updater: "electron", tagPrefix: "app/v", build });
  assert.equal(file.tagPrefix, "app/v");
  assert.equal(file.build.kind, "electron");
  if (file.build.kind === "electron") {
    assert.equal(expandPath(file.build.zip, "1.2.3"), "dist/Proactive-Agent-1.2.3-mac.zip");
  }
});

test("Sparkle keys: 32-byte seed, raw public key, sign and verify", () => {
  const keys = generateSparkleKeys();
  assert.equal(Buffer.from(keys.privateKey, "base64").length, 32);
  assert.equal(Buffer.from(keys.publicKey, "base64").length, 32);
  assert.equal(publicKeyFor(keys.privateKey), keys.publicKey);

  const data = Buffer.from("pretend this is a DMG");
  const signature = signArchive(data, keys.privateKey);
  assert.equal(Buffer.from(signature, "base64").length, 64);
  assert.ok(verifyArchive(data, signature, keys.publicKey));
  assert.ok(!verifyArchive(Buffer.from("tampered"), signature, keys.publicKey));
  assert.ok(!verifyArchive(data, signature, generateSparkleKeys().publicKey));
  // Ed25519 is deterministic: the same key and bytes give the same signature.
  assert.equal(signArchive(data, keys.privateKey), signature);
});

test("Sparkle keys: accepts seed+public (64 bytes), rejects other shapes", () => {
  const keys = generateSparkleKeys();
  const combined = Buffer.concat([Buffer.from(keys.privateKey, "base64"), Buffer.from(keys.publicKey, "base64")]).toString("base64");
  assert.equal(publicKeyFor(combined), keys.publicKey);
  const wrongTail = Buffer.concat([Buffer.from(keys.privateKey, "base64"), Buffer.alloc(32, 7)]).toString("base64");
  assert.throws(() => readPrivateKey(wrongTail), /seed followed by its public key/);
  assert.throws(() => readPrivateKey(Buffer.alloc(96).toString("base64")), /96 bytes/);
  assert.throws(() => readPrivateKey("not base64!!"), /isn't base64/);
});

test("Sparkle public key matches node's own Ed25519 export", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16).toString("base64");
  const expected = publicKey.export({ format: "jwk" }).x!;
  assert.equal(Buffer.from(publicKeyFor(seed), "base64").toString("base64url"), expected);
});

test("config round trip and URL rules", async () => {
  const home = await mkdtemp(join(tmpdir(), "apps-config-"));
  try {
    const env = { APPS_CONFIG_DIR: join(home, "nested", "apps") };
    assert.deepEqual(await loadConfig(env), { remotes: {} });
    await saveConfig(env, { remotes: { moulik: { url: "https://apps.moulik.dev" } }, appleIssuerId: "issuer" });
    assert.deepEqual(await loadConfig(env), { remotes: { moulik: { url: "https://apps.moulik.dev" } }, appleIssuerId: "issuer" });
    assert.match(await readFile(join(home, "nested", "apps", "config.json"), "utf8"), /"moulik"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  assert.equal(normalizeUrl("https://apps.moulik.dev///"), "https://apps.moulik.dev");
  assert.throws(() => normalizeUrl("https://user:pw@x.dev"), /credentials/);
  assert.throws(() => normalizeUrl("https://x.dev/?a=1"), /query/);
});

test("feed versions are read from both feed formats", () => {
  assert.equal(feedVersion("sparkle", "<rss><item><sparkle:shortVersionString>1.2.3</sparkle:shortVersionString></item><item><sparkle:shortVersionString>1.2.2</sparkle:shortVersionString></item></rss>"), "1.2.3");
  assert.equal(feedVersion("sparkle", '<enclosure sparkle:shortVersionString="2.0.0" />'), "2.0.0");
  assert.equal(feedVersion("sparkle", "<rss><channel></channel></rss>"), null);
  assert.equal(feedVersion("electron", "version: 0.4.21\nfiles: []\n"), "0.4.21");
  assert.equal(feedVersion("electron", "version: '0.4.21'\n"), "0.4.21");
});
