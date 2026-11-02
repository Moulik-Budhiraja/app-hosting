// Tests the tag-prefix handling in scripts/common/read-config.mjs and check-tag.sh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const script = (name: string) => fileURLToPath(new URL(`../../scripts/common/${name}`, import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "tag-prefixes-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const appFile = {
  app: "proactive-agent",
  remote: { name: "proletic", url: "https://apps.proletic.co" },
  updater: "electron",
  builds: { windows: { kind: "electron", command: "npm run build:win", installer: "dist/A-Setup-{version}.exe" } },
};

function readConfig(tagPrefix: unknown): { code: number | null; out: Record<string, string>; stderr: string } {
  const path = join(dir, `apps-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(tagPrefix === undefined ? appFile : { ...appFile, tagPrefix }));
  const r = spawnSync(process.execPath, [script("read-config.mjs"), path, "windows"], { encoding: "utf8" });
  const out = Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  return { code: r.status, out, stderr: r.stderr };
}

function checkTag(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", [script("check-tag.sh"), ...args], { encoding: "utf8", env: { ...process.env, SKIP_MAIN_CHECK: "1" } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("read-config gives the first prefix and every prefix, longest first", () => {
  assert.deepEqual([readConfig(undefined).out.tag_prefix, readConfig(undefined).out.tag_prefixes], ["v", "v"]);
  const one = readConfig("win-v");
  assert.equal(one.code, 0, one.stderr);
  assert.deepEqual([one.out.tag_prefix, one.out.tag_prefixes], ["win-v", "win-v"]);
  const two = readConfig(["v", "win-v"]);
  assert.equal(two.code, 0, two.stderr);
  assert.deepEqual([two.out.tag_prefix, two.out.tag_prefixes], ["v", "win-v v"]);
  for (const [bad, message] of [[[], /non-empty string or a list/], [["v", "v"], /same prefix twice/], [["v", ""], /non-empty string or a list/], [["v", "w v"], /spaces or wildcard/], [7, /non-empty string or a list/]] as const) {
    const r = readConfig(bad);
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.match(r.stderr, message);
  }
});

test("check-tag with one prefix works as before", () => {
  assert.deepEqual(checkTag("v1.2.3", "v"), { code: 0, stdout: "version=1.2.3\nbuild=100200300\nprefix=v\n", stderr: "" });
  assert.equal(checkTag("v1.2.3").stdout, "version=1.2.3\nbuild=100200300\nprefix=v\n");
  assert.equal(checkTag("app/v0.4.2", "app/v").stdout, "version=0.4.2\nbuild=400200\nprefix=app/v\n");
  assert.match(checkTag("x1.2.3", "v").stderr, /^error: tag x1\.2\.3 doesn't start with v\n$/);
  assert.match(checkTag("v1.2", "v").stderr, /tags look like v1\.2\.3, not v1\.2/);
  assert.match(checkTag("v1.1000.0", "v").stderr, /below 1000/);
});

test("check-tag takes the version from the longest prefix the tag starts with", () => {
  assert.equal(checkTag("win-v0.7.27", "v", "win-v").stdout, "version=0.7.27\nbuild=702700\nprefix=win-v\n");
  assert.equal(checkTag("v0.7.28", "win-v", "v").stdout, "version=0.7.28\nbuild=702800\nprefix=v\n");
  // Overlapping prefixes: v-beta1.2.3 starts with both, and the longer one wins whatever the order.
  assert.equal(checkTag("v-beta1.2.3", "v", "v-beta").stdout, "version=1.2.3\nbuild=100200300\nprefix=v-beta\n");
  assert.equal(checkTag("v-beta1.2.3", "v-beta", "v").stdout, "version=1.2.3\nbuild=100200300\nprefix=v-beta\n");
  assert.equal(checkTag("v1.2.3", "v", "v-beta").stdout, "version=1.2.3\nbuild=100200300\nprefix=v\n");
  const none = checkTag("mac-v1.2.3", "v", "win-v");
  assert.equal(none.code, 1);
  assert.match(none.stderr, /doesn't start with v or win-v/);
  assert.match(checkTag("win-v1.2", "v", "win-v").stderr, /tags look like v1\.2\.3 or win-v1\.2\.3, not win-v1\.2/);
});
