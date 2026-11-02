import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SPARKLE_SERVICE, TOKEN_SERVICE } from "../src/secrets.js";
import { verifyArchive } from "../src/sparkle.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { harness } from "./helpers.js";

let server: FakeServer;
before(async () => { server = await startFakeServer(); });
after(async () => { await server.close(); });

async function loggedIn(name = "moulik") {
  const h = await harness({ stdin: `${server.adminToken}\n` });
  assert.equal((await h.run("remote", "add", name, server.url)).code, 0);
  const login = await h.run("login", name, "--token-stdin");
  assert.equal(login.code, 0, login.stderr);
  return h;
}

test("remotes: add, list, refuse a changed URL, remove", async () => {
  const h = await harness();
  try {
    assert.equal((await h.run("remote", "add", "moulik", "https://apps.moulik.dev/")).code, 0);
    assert.equal((await h.run("remote", "add", "proletic", "https://apps.proletic.co")).code, 0);
    const listed = await h.run("remote", "list", "--json");
    assert.deepEqual(JSON.parse(listed.stdout), [
      { name: "moulik", url: "https://apps.moulik.dev", loggedIn: false },
      { name: "proletic", url: "https://apps.proletic.co", loggedIn: false },
    ]);
    const clash = await h.run("remote", "add", "moulik", "https://elsewhere.dev");
    assert.equal(clash.code, 2);
    assert.match(clash.stderr, /already points at https:\/\/apps\.moulik\.dev/);
    assert.equal((await h.run("remote", "remove", "proletic")).code, 0);
    assert.equal(JSON.parse((await h.run("remote", "list", "--json")).stdout).length, 1);
    const unknown = await h.run("login", "nope");
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown remote "nope"\. Add it with: apps remote add nope <url>/);
  } finally {
    await h.cleanup();
  }
});

test("login stores only admin tokens", async () => {
  const h = await loggedIn();
  try {
    assert.equal(await h.secrets.get(TOKEN_SERVICE, "moulik"), server.adminToken);
    const bad = await harness({ stdin: "wrong-token\n" });
    await bad.run("remote", "add", "moulik", server.url);
    const refused = await bad.run("login", "moulik", "--token-stdin");
    assert.equal(refused.code, 3);
    assert.match(refused.stderr, /refused\. Run: apps login moulik/);
    assert.equal(await bad.secrets.get(TOKEN_SERVICE, "moulik"), null);
    await bad.cleanup();
  } finally {
    await h.cleanup();
  }
});

test("not logged in errors say how to log in", async () => {
  const h = await harness();
  try {
    await h.run("remote", "add", "moulik", server.url);
    const result = await h.run("create", "lonely-app", "--remote", "moulik", "--updater", "electron");
    assert.equal(result.code, 3);
    assert.match(result.stderr, /Not logged in to moulik\. Run: apps login moulik/);
  } finally {
    await h.cleanup();
  }
});

test("sparkle app: create, publish, status, releases, withdraw", async () => {
  const h = await loggedIn();
  try {
    const created = await h.run("create", "screen-draw", "--remote", "moulik", "--updater", "sparkle", "--title", "ScreenDraw", "--json");
    assert.equal(created.code, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);
    const privateKey = await h.secrets.get(SPARKLE_SERVICE, "moulik/screen-draw");
    assert.ok(privateKey);
    assert.equal(server.apps.get("screen-draw")!.sparklePublicKey, createdJson.sparklePublicKey);
    const appsJson = JSON.parse(await readFile(join(h.dir, "apps.json"), "utf8"));
    assert.deepEqual(appsJson, {
      app: "screen-draw",
      remote: { name: "moulik", url: server.url },
      updater: "sparkle",
      tagPrefix: "v",
      builds: { mac: { kind: "native", command: "./scripts/build.sh", app: "build/ScreenDraw.app", entitlements: null, dmgName: "ScreenDraw" } },
    });

    // Running create again in the same repo is refused.
    const again = await h.run("create", "screen-draw", "--remote", "moulik", "--updater", "sparkle");
    assert.equal(again.code, 2);

    const dmg = join(h.dir, "ScreenDraw-1.0.0.dmg");
    await writeFile(dmg, Buffer.alloc(300_000, 3));
    await writeFile(join(h.dir, "notes.md"), "- First release");
    const published = await h.run("publish", "--version", "1.0.0", "--dmg", "ScreenDraw-1.0.0.dmg", "--notes-file", "notes.md", "--json");
    assert.equal(published.code, 0, published.stderr);
    const release = JSON.parse(published.stdout).release;
    assert.equal(release.version, "1.0.0");
    assert.equal(release.build, 100000000);
    const stored = server.apps.get("screen-draw")!.releases[0]!;
    assert.equal(stored.notes, "- First release");
    assert.equal(stored.files[0]!.platform, "mac");
    assert.ok(verifyArchive(await readFile(dmg), stored.files[0]!.edSignature!, createdJson.sparklePublicKey));

    const status = await h.run("status");
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /macOS\n    Latest release: 1\.0\.0 \(build 100000000/);
    assert.doesNotMatch(status.stdout, /Windows/);
    assert.match(status.stdout, /✓ The feed is up to date/);
    assert.equal((await h.run("status", "--expect", "1.0.0")).code, 0);
    assert.equal((await h.run("status", "--expect", "1.0.1")).code, 1);

    // Same version again: the server refuses, and the CLI passes its message on.
    const duplicate = await h.run("publish", "--version", "1.0.0", "--dmg", "ScreenDraw-1.0.0.dmg");
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /already has mac files/);

    await writeFile(join(h.dir, "ScreenDraw-1.1.0.dmg"), Buffer.alloc(1000, 9));
    assert.equal((await h.run("publish", "--version", "1.1.0", "--dmg", "ScreenDraw-1.1.0.dmg")).code, 0);
    const releases = JSON.parse((await h.run("releases", "--json")).stdout).releases;
    assert.deepEqual(releases.map((item: { version: string }) => item.version), ["1.1.0", "1.0.0"]);

    assert.equal((await h.run("withdraw", "1.1.0")).code, 0);
    const afterWithdraw = JSON.parse((await h.run("status", "--json")).stdout);
    assert.equal(afterWithdraw.platforms[0].platform, "mac");
    assert.equal(afterWithdraw.platforms[0].latest.version, "1.0.0");
    assert.equal(afterWithdraw.platforms[0].feed.version, "1.0.0");
    assert.equal(afterWithdraw.ok, true);
    assert.equal((await h.run("restore", "1.1.0")).code, 0);
    assert.equal(JSON.parse((await h.run("status", "--json")).stdout).platforms[0].feed.version, "1.1.0");

    // Sparkle apps don't take a zip.
    const zip = await h.run("publish", "--version", "1.2.0", "--dmg", "ScreenDraw-1.1.0.dmg", "--zip", "x.zip");
    assert.equal(zip.code, 2);
  } finally {
    await h.cleanup();
  }
});

test("CI publish: APPS_TOKEN publish token and SPARKLE_PRIVATE_KEY, no keychain", async () => {
  const admin = await loggedIn();
  try {
    assert.equal((await admin.run("create", "ci-app", "--remote", "moulik", "--updater", "sparkle")).code, 0);
    const key = (await admin.secrets.get(SPARKLE_SERVICE, "moulik/ci-app"))!;
    const token = JSON.parse((await admin.run("token", "create", "--label", "ci", "--json")).stdout).token;
    const appsJson = await readFile(join(admin.dir, "apps.json"), "utf8");

    const ci = await harness({ env: { APPS_TOKEN: token, SPARKLE_PRIVATE_KEY: key } });
    await writeFile(join(ci.dir, "apps.json"), appsJson);
    await writeFile(join(ci.dir, "Ci-1.0.0.dmg"), Buffer.alloc(5000, 1));
    const published = await ci.run("publish", "--version", "1.0.0", "--dmg", "Ci-1.0.0.dmg");
    assert.equal(published.code, 0, published.stderr);
    assert.match(published.stdout, /Published ci-app 1\.0\.0 \(build 100000000\)/);

    // A publish token can't do admin things.
    const withdraw = await ci.run("withdraw", "1.0.0");
    assert.equal(withdraw.code, 3);
    assert.match(withdraw.stderr, /admin token/);

    // A wrong Sparkle key is caught before uploading.
    const wrong = await harness({ env: { APPS_TOKEN: token, SPARKLE_PRIVATE_KEY: Buffer.alloc(32, 5).toString("base64") } });
    await writeFile(join(wrong.dir, "apps.json"), appsJson);
    await writeFile(join(wrong.dir, "Ci-1.1.0.dmg"), Buffer.alloc(10, 1));
    const mismatch = await wrong.run("publish", "--version", "1.1.0", "--dmg", "Ci-1.1.0.dmg");
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.stderr, /doesn't match ci-app's public key/);
    assert.ok(!server.requests.some((line) => line.includes("/ci-app/uploads") && line.startsWith("POST") && server.apps.get("ci-app")!.releases.length > 1));
    await ci.cleanup();
    await wrong.cleanup();
  } finally {
    await admin.cleanup();
  }
});

test("electron app: create, publish with zip and blockmap", async () => {
  const h = await loggedIn();
  try {
    const created = await h.run("create", "proactive-agent", "--remote", "moulik", "--updater", "electron", "--title", "Proactive Agent");
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /provider: generic, url: .*\/proactive-agent\//);
    const file = JSON.parse(await readFile(join(h.dir, "apps.json"), "utf8"));
    assert.equal(file.builds.mac.zip, "dist/Proactive-Agent-{version}-mac.zip");

    await writeFile(join(h.dir, "Proactive-Agent.dmg"), Buffer.alloc(2000, 1));
    await writeFile(join(h.dir, "Proactive-Agent-0.5.0-mac.zip"), Buffer.alloc(3000, 2));
    await writeFile(join(h.dir, "Proactive-Agent-0.5.0-mac.zip.blockmap"), Buffer.alloc(40, 3));
    const missingZip = await h.run("publish", "--version", "0.5.0", "--dmg", "Proactive-Agent.dmg");
    assert.equal(missingZip.code, 2);
    assert.match(missingZip.stderr, /need --zip/);
    const badBlockmap = await h.run("publish", "--version", "0.5.0", "--dmg", "Proactive-Agent.dmg", "--zip", "Proactive-Agent-0.5.0-mac.zip", "--blockmap", "Proactive-Agent.dmg");
    assert.equal(badBlockmap.code, 2);

    const published = await h.run("publish", "--version", "0.5.0", "--dmg", "Proactive-Agent.dmg", "--zip", "Proactive-Agent-0.5.0-mac.zip", "--blockmap", "Proactive-Agent-0.5.0-mac.zip.blockmap", "--json");
    assert.equal(published.code, 0, published.stderr);
    const release = JSON.parse(published.stdout).release;
    assert.deepEqual(release.files.map((item: { role: string }) => item.role), ["dmg", "zip", "blockmap"]);
    assert.equal(release.edSignature, undefined);
    assert.match(JSON.parse(published.stdout).feed, /\/proactive-agent\/latest-mac\.yml$/);
    const status = await h.run("status", "--json");
    assert.equal(JSON.parse(status.stdout).platforms[0].feed.version, "0.5.0");
  } finally {
    await h.cleanup();
  }
});

test("icons: publish --icon, apps icon, apps icon --remove", async () => {
  const h = await loggedIn();
  const png = (size: number) => {
    const data = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
    data.writeUInt32BE(13, 8);
    data.write("IHDR", 12, "latin1");
    data.writeUInt32BE(size, 16);
    data.writeUInt32BE(size, 20);
    return data;
  };
  try {
    assert.equal((await h.run("create", "iconic", "--remote", "moulik", "--updater", "sparkle", "--title", "Iconic")).code, 0);
    await writeFile(join(h.dir, "Iconic-1.0.0.dmg"), Buffer.alloc(2000, 1));
    await writeFile(join(h.dir, "icon.png"), png(256));
    await writeFile(join(h.dir, "tiny.png"), png(8));
    await writeFile(join(h.dir, "fake.png"), "<svg/>");

    // A bad icon stops publish before anything is uploaded.
    const before = server.requests.length;
    const bad = await h.run("publish", "--version", "1.0.0", "--dmg", "Iconic-1.0.0.dmg", "--icon", "fake.png");
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /isn't a PNG/);
    assert.ok(!server.requests.slice(before).some((line) => line.includes("/uploads")));
    const app = await h.run("publish", "--version", "1.0.0", "--dmg", "Iconic-1.0.0.dmg", "--icon", "Some.app");
    assert.match(app.stderr, /app-icon\.sh/);

    const published = await h.run("publish", "--version", "1.0.0", "--dmg", "Iconic-1.0.0.dmg", "--icon", "icon.png", "--json");
    assert.equal(published.code, 0, published.stderr);
    assert.equal(JSON.parse(published.stdout).iconUpdated, true);
    assert.deepEqual(server.apps.get("iconic")!.iconData, png(256));

    assert.equal((await h.run("icon", "tiny.png")).code, 2);
    const set = await h.run("icon", "icon.png", "--json");
    assert.equal(set.code, 0, set.stderr);
    assert.match(JSON.parse(set.stdout).url, /\/iconic\/icon\.png\?v=[0-9a-f]{12}$/);

    assert.equal((await h.run("icon")).code, 2);
    const removed = await h.run("icon", "--remove");
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(server.apps.get("iconic")!.icon, undefined);
  } finally {
    await h.cleanup();
  }
});

test("tokens: create, list, revoke", async () => {
  const h = await loggedIn();
  try {
    await h.run("create", "token-app", "--remote", "moulik", "--updater", "electron");
    const created = JSON.parse((await h.run("token", "create", "--label", "laptop", "--json")).stdout);
    assert.match(created.token, /^pub-/);
    const listed = await h.run("token", "list");
    assert.match(listed.stdout, new RegExp(`${created.id}\\s+laptop`));
    assert.doesNotMatch(listed.stdout, /pub-/);
    assert.equal((await h.run("token", "revoke", created.id)).code, 0);
    assert.equal(JSON.parse((await h.run("token", "list", "--json")).stdout).tokens.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("releases without apps.json, by --app and --remote, falls back to public data", async () => {
  const h = await harness();
  try {
    await h.run("remote", "add", "moulik", server.url);
    const result = await h.run("releases", "--app", "screen-draw", "--remote", "moulik", "--json");
    assert.equal(result.code, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).releases.length >= 1);
    const missing = await h.run("releases");
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /No apps\.json/);
  } finally {
    await h.cleanup();
  }
});

test("build-number, help and unknown commands", async () => {
  const h = await harness();
  try {
    assert.deepEqual(JSON.parse((await h.run("build-number", "1.2.3", "--json")).stdout), { version: "1.2.3", build: 100200300 });
    assert.equal((await h.run("--help")).code, 0);
    const unknown = await h.run("deploy");
    assert.equal(unknown.code, 2);
    const badFlag = await h.run("publish", "--nope");
    assert.equal(badFlag.code, 2);
    const jsonError = await h.run("build-number", "x", "--json");
    assert.equal(JSON.parse(jsonError.stderr).error.code, "USAGE");
  } finally {
    await h.cleanup();
  }
});

test("sparkle app on macOS and Windows: one release, each platform published on its own", async () => {
  const h = await loggedIn();
  try {
    const created = await h.run("create", "dual-draw", "--remote", "moulik", "--updater", "sparkle", "--title", "Dual Draw", "--platforms", "windows,mac", "--json");
    assert.equal(created.code, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);
    assert.match(createdJson.feeds.windows, /\/dual-draw\/appcast-windows\.xml$/);
    const appsJson = JSON.parse(await readFile(join(h.dir, "apps.json"), "utf8"));
    assert.deepEqual(Object.keys(appsJson.builds), ["mac", "windows"]);
    assert.deepEqual(appsJson.builds.windows, { kind: "native", command: "./scripts/build.ps1", installer: "build/DualDraw-Setup-{version}.exe" });
    const human = await h.run("create", "other-app", "--remote", "moulik", "--updater", "sparkle", "--platforms", "linux", "-C", h.home);
    assert.equal(human.code, 2);
    assert.match(human.stderr, /"linux" isn't a platform/);

    await writeFile(join(h.dir, "DualDraw-1.0.0.dmg"), Buffer.alloc(4000, 1));
    await writeFile(join(h.dir, "DualDraw-Setup-1.0.0.exe"), Buffer.alloc(5000, 2));
    await writeFile(join(h.dir, "notes.md"), "- Now on Windows");

    // Windows first; --installer picks the platform.
    const windows = await h.run("publish", "--version", "1.0.0", "--installer", "DualDraw-Setup-1.0.0.exe", "--minimum-system-version", "10.0.17763", "--notes-file", "notes.md", "--json");
    assert.equal(windows.code, 0, windows.stderr);
    const windowsJson = JSON.parse(windows.stdout);
    assert.equal(windowsJson.platform, "windows");
    assert.match(windowsJson.feed, /appcast-windows\.xml$/);
    const stored = server.apps.get("dual-draw")!.releases[0]!;
    assert.deepEqual(stored.files.map((file) => [file.platform, file.role]), [["windows", "installer"]]);
    assert.equal(stored.platforms.windows!.minimumSystemVersion, "10.0.17763");
    assert.ok(verifyArchive(await readFile(join(h.dir, "DualDraw-Setup-1.0.0.exe")), stored.files[0]!.edSignature!, createdJson.sparklePublicKey));

    // The status of a platform that has nothing yet is a mismatch, not an error.
    const half = JSON.parse((await h.run("status", "--json")).stdout);
    assert.deepEqual(half.platforms.map((item: { platform: string; ok: boolean }) => [item.platform, item.ok]), [["mac", true], ["windows", true]]);
    assert.equal(half.platforms[0].latest, null);
    assert.equal((await h.run("status", "--expect", "1.0.0")).code, 1);
    assert.equal((await h.run("status", "--expect", "1.0.0", "--platform", "windows")).code, 0);

    // macOS joins the same release.
    const mac = await h.run("publish", "--version", "1.0.0", "--dmg", "DualDraw-1.0.0.dmg", "--json");
    assert.equal(mac.code, 0, mac.stderr);
    assert.equal(JSON.parse(mac.stdout).platform, "mac");
    assert.equal(server.apps.get("dual-draw")!.releases.length, 1);
    assert.deepEqual(stored.files.map((file) => file.platform), ["windows", "mac"]);
    assert.equal(stored.notes, "- Now on Windows");

    const status = await h.run("status", "--expect", "1.0.0");
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /macOS\n    Latest release: 1\.0\.0/);
    assert.match(status.stdout, /Windows\n    Latest release: 1\.0\.0[^\n]*\n    Live feed:      1\.0\.0  .*appcast-windows\.xml/);
    const releases = await h.run("releases");
    assert.match(releases.stdout, /PLATFORMS/);
    assert.match(releases.stdout, /1\.0\.0 .*mac, windows\s+live/);

    // Flags that don't fit the platform or updater.
    const cases: [string[], RegExp][] = [
      [["--installer", "DualDraw-Setup-1.0.0.exe", "--dmg", "DualDraw-1.0.0.dmg"], /--dmg and --zip are for macOS/],
      [["--platform", "mac", "--installer", "DualDraw-Setup-1.0.0.exe"], /--installer is for Windows/],
      [["--platform", "windows"], /Pass --installer/],
      [["--installer", "DualDraw-1.0.0.dmg"], /must end in \.exe or \.msi/],
      [["--installer", "DualDraw-Setup-1.0.0.exe", "--blockmap", "x.blockmap"], /--blockmap is for electron apps/],
      [["--installer", "DualDraw-Setup-1.0.0.exe", "--minimum-system-version", "Windows 10"], /10\.0 or 10\.0\.17763 on Windows/],
      [["--platform", "linux", "--dmg", "x.dmg"], /--platform must be mac or windows/],
    ];
    for (const [args, message] of cases) {
      const result = await h.run("publish", "--version", "1.1.0", ...args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.stderr, message);
    }
  } finally {
    await h.cleanup();
  }
});

test("electron app on Windows: installer and its blockmap", async () => {
  const h = await loggedIn();
  try {
    const created = await h.run("create", "win-agent", "--remote", "moulik", "--updater", "electron", "--title", "Win Agent", "--platforms", "windows");
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /azureSignOptions/);
    assert.doesNotMatch(created.stdout, /SUFeedURL/);
    const file = JSON.parse(await readFile(join(h.dir, "apps.json"), "utf8"));
    assert.deepEqual(Object.keys(file.builds), ["windows"]);
    assert.equal(file.builds.windows.blockmap, "dist/Win-Agent-Setup-{version}.exe.blockmap");

    await writeFile(join(h.dir, "Win-Agent-Setup-0.2.0.exe"), Buffer.alloc(3000, 2));
    await writeFile(join(h.dir, "Win-Agent-Setup-0.2.0.exe.blockmap"), Buffer.alloc(40, 3));
    await writeFile(join(h.dir, "Win-Agent-Setup-0.2.0.msi"), Buffer.alloc(30, 3));
    const msi = await h.run("publish", "--version", "0.2.0", "--installer", "Win-Agent-Setup-0.2.0.msi");
    assert.equal(msi.code, 2);
    assert.match(msi.stderr, /NSIS installer ending in \.exe/);
    const badBlockmap = await h.run("publish", "--version", "0.2.0", "--installer", "Win-Agent-Setup-0.2.0.exe", "--blockmap", "Win-Agent-Setup-0.2.0.msi");
    assert.equal(badBlockmap.code, 2);
    assert.match(badBlockmap.stderr, /must be named Win-Agent-Setup-0\.2\.0\.exe\.blockmap/);

    const published = await h.run("publish", "--version", "0.2.0", "--installer", "Win-Agent-Setup-0.2.0.exe", "--blockmap", "Win-Agent-Setup-0.2.0.exe.blockmap", "--json");
    assert.equal(published.code, 0, published.stderr);
    const json = JSON.parse(published.stdout);
    assert.match(json.feed, /\/win-agent\/latest\.yml$/);
    assert.deepEqual(json.release.files.map((item: { platform: string; role: string }) => [item.platform, item.role]), [["windows", "installer"], ["windows", "blockmap"]]);
    assert.equal(json.release.files[0].edSignature, undefined);

    const status = JSON.parse((await h.run("status", "--json")).stdout);
    assert.deepEqual(status.platforms.map((item: { platform: string }) => item.platform), ["windows"]);
    assert.equal(status.platforms[0].feed.version, "0.2.0");
    assert.match(status.platforms[0].feed.url, /latest\.yml$/);
    assert.equal(status.ok, true);
  } finally {
    await h.cleanup();
  }
});
