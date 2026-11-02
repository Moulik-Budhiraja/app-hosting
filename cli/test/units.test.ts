import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultBuildSection, expandPath, feedName, platformsOf, validateAppFile } from "../src/appfile.js";
import { feedVersion } from "../src/commands/manage.js";
import { publishPlatform } from "../src/commands/publish.js";
import { integrationLines, parsePlatforms, workflowForm, workflowTemplate } from "../src/commands/setup.js";
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

test("apps.json validation fills defaults and normalizes; a top-level build is the macOS build", () => {
  const file = validateAppFile(nativeFile);
  assert.equal(file.tagPrefix, "v");
  assert.equal(file.remote.url, "https://apps.moulik.dev");
  assert.deepEqual(platformsOf(file), ["mac"]);
  assert.equal(file.builds.windows, undefined);
  assert.deepEqual(file.builds.mac, {
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
  assert.equal(file.builds.mac!.kind, "electron");
  if (file.builds.mac!.kind === "electron") {
    assert.equal(expandPath(file.builds.mac!.zip, "1.2.3"), "dist/Proactive-Agent-1.2.3-mac.zip");
  }
});

const windowsNative = { kind: "native", command: "./scripts/build.ps1", installer: "build/ScreenDraw-Setup-{version}.exe" };
const { build: _legacy, ...base } = nativeFile;

test("apps.json builds: both platforms, Windows fields and defaults", () => {
  const file = validateAppFile({
    ...base,
    builds: {
      mac: nativeFile.build,
      windows: { ...windowsNative, minimumSystemVersion: "10.0.17763", icon: "assets/icon.png" },
    },
  });
  assert.deepEqual(platformsOf(file), ["mac", "windows"]);
  assert.deepEqual(file.builds.windows, { ...windowsNative, minimumSystemVersion: "10.0.17763", icon: "assets/icon.png" });

  const windowsOnly = validateAppFile({ ...base, builds: { windows: { ...windowsNative, installer: "out/Setup.msi" } } });
  assert.deepEqual(platformsOf(windowsOnly), ["windows"]);

  const electron = defaultBuildSection("proactive-agent", "Proactive Agent", "electron", "windows");
  assert.deepEqual(electron, {
    kind: "electron",
    command: "npm run build:win",
    installer: "dist/Proactive-Agent-Setup-{version}.exe",
    blockmap: "dist/Proactive-Agent-Setup-{version}.exe.blockmap",
  });
  const parsed = validateAppFile({ ...base, updater: "electron", builds: { windows: electron } });
  assert.deepEqual(parsed.builds.windows, electron);
  assert.deepEqual(defaultBuildSection("screen-draw", "Screen Draw", "native", "windows"), {
    kind: "native", command: "./scripts/build.ps1", installer: "build/ScreenDraw-Setup-{version}.exe",
  });
});

test("apps.json builds: validation errors", () => {
  const withWindows = (windows: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    validateAppFile({ ...base, ...extra, builds: { windows } });
  assert.throws(() => validateAppFile({ ...nativeFile, builds: { mac: nativeFile.build } }), /use "builds" only/);
  assert.throws(() => validateAppFile(base), /builds is required/);
  assert.throws(() => validateAppFile({ ...base, builds: {} }), /needs a "mac" or "windows" build/);
  assert.throws(() => validateAppFile({ ...base, builds: { linux: windowsNative } }), /builds\.linux isn't a platform/);
  assert.throws(() => withWindows({ ...windowsNative, installer: "build/Setup.zip" }), /builds\.windows\.installer must end in \.exe or \.msi/);
  assert.throws(() => withWindows({ ...windowsNative, kind: "electron", installer: "dist/Setup.msi" }, { updater: "electron" }), /\.exe \(an NSIS installer\)/);
  assert.throws(() => withWindows({ ...windowsNative, kind: "electron" }), /needs updater "electron"/);
  assert.throws(() => withWindows(windowsNative, { updater: "electron" }), /needs updater "sparkle"/);
  assert.throws(() => withWindows({ ...windowsNative, blockmap: "x.blockmap" }), /only for electron builds/);
  assert.throws(
    () => withWindows({ kind: "electron", command: "x", installer: "dist/App-{version}.exe", blockmap: "dist/App.exe.blockmap" }, { updater: "electron" }),
    /must be named App-\{version\}\.exe\.blockmap/,
  );
  assert.throws(() => withWindows({ ...windowsNative, minimumSystemVersion: "Windows 10" }), /look like 10\.0/);
  assert.throws(() => withWindows({ ...windowsNative, installer: "../Setup.exe" }), /inside the repo/);
  assert.throws(() => withWindows({ ...windowsNative, installer: "C:\\out\\Setup.exe" }), /inside the repo/);
  assert.throws(() => withWindows({ ...windowsNative, icon: "/tmp/icon.png" }), /builds\.windows\.icon must be a path inside the repo/);
  assert.throws(() => withWindows({ ...windowsNative, command: "" }), /builds\.windows\.command/);
});

test("feeds, platforms and the release workflow template", () => {
  assert.equal(feedName("sparkle", "mac"), "appcast.xml");
  assert.equal(feedName("sparkle", "windows"), "appcast-windows.xml");
  assert.equal(feedName("electron", "mac"), "latest-mac.yml");
  assert.equal(feedName("electron", "windows"), "latest.yml");
  assert.deepEqual(parsePlatforms(undefined), ["mac"]);
  assert.deepEqual(parsePlatforms("windows, mac"), ["mac", "windows"]);
  assert.throws(() => parsePlatforms("linux"), /isn't a platform/);
  assert.throws(() => parsePlatforms(","), /at least one/);
  assert.equal(publishPlatform({}), "mac");
  assert.equal(publishPlatform({ installer: "Setup.exe" }), "windows");
  assert.equal(publishPlatform({ platform: "mac", installer: "Setup.exe" }), "mac");
  assert.throws(() => publishPlatform({ platform: "win" }), /mac or windows/);

  const both = workflowTemplate("app/v", ["mac", "windows"]);
  assert.match(both, /tags: \['app\/v\*'\]/);
  assert.match(both, /  mac:\n    uses: Moulik-Budhiraja\/app-hosting\/\.github\/workflows\/release-mac\.yml@main\n    secrets: inherit\n/);
  assert.match(both, /  windows:\n    uses: Moulik-Budhiraja\/app-hosting\/\.github\/workflows\/release-windows\.yml@main\n    secrets: inherit\n/);
  assert.doesNotMatch(workflowTemplate("v", ["windows"]), /release-mac/);
});

test("repos outside Moulik-Budhiraja get the composite-action workflow", () => {
  assert.equal(workflowForm("Moulik-Budhiraja/screen-draw"), "reusable");
  assert.equal(workflowForm("moulik-budhiraja/screen-draw"), "reusable");
  assert.equal(workflowForm("Proletic/proactive-agent"), "action");
  assert.equal(workflowForm("someone/app"), "action");

  const both = workflowTemplate("win-v", ["mac", "windows"], "action");
  assert.match(both, /tags: \['win-v\*'\]/);
  assert.match(both, /permissions:\n  contents: read\n/);
  for (const [platform, runner] of [["mac", "\\[self-hosted, macos-ephemeral\\]"], ["windows", "\\[self-hosted, windows\\]"]]) {
    assert.match(both, new RegExp(`  ${platform}:\\n    runs-on: ${runner}\\n    environment: production\\n    timeout-minutes: 90\\n`));
    assert.match(both, new RegExp(`group: release-${platform}-\\$\\{\\{ github\\.repository \\}\\}`));
    assert.match(both, new RegExp(`uses: Moulik-Budhiraja/app-hosting/actions/release-${platform}@main\\n        with:\\n          secrets: \\$\\{\\{ toJSON\\(secrets\\) \\}\\}`));
  }
  assert.doesNotMatch(both, /^ +secrets: inherit$|uses: .*\.github\/workflows/m);
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
  assert.equal(feedVersion("electron", "version: \"1.2.3\"\nfiles:\n  - url: \"releases/1.2.3/App-Setup-1.2.3.exe\"\n"), "1.2.3");
  assert.equal(feedVersion("sparkle", "<item><sparkle:version>1.2.3</sparkle:version><sparkle:shortVersionString>1.2.3</sparkle:shortVersionString></item>"), "1.2.3");
});

test("electron hints carry the electron-builder 26 notes", () => {
  const file = {
    app: "chat",
    remote: { name: "moulik", url: "https://apps.moulik.dev" },
    updater: "electron" as const,
    builds: { mac: defaultBuildSection("chat", "Chat", "electron", "mac"), windows: defaultBuildSection("chat", "Chat", "electron", "windows") },
  };
  const text = integrationLines(file).join("\n");
  assert.match(text, /--config\.extraMetadata\.version=\$VERSION/);
  assert.match(text, /npm version \$VERSION --no-git-tag-version/);
  assert.match(text, /reads -c\.extraMetadata\.version=… *\n? *as a config path/);
  assert.match(text, /--config electron-builder\.config\.js/);
  assert.match(text, /doesn't load it on its own/);
  assert.doesNotMatch(text, /use a JS config/);

  const macOnly = integrationLines({ ...file, builds: { mac: file.builds.mac } }).join("\n");
  assert.match(macOnly, /extraMetadata/);
  assert.doesNotMatch(macOnly, /Artifact Signing/);
});
