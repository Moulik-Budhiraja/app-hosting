// Tests the tag-prefix handling in scripts/common/read-config.mjs and check-tag.sh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function readConfig(tagPrefix: unknown, extra: Record<string, unknown> = {}): { code: number | null; out: Record<string, string>; stderr: string } {
  const path = join(dir, `apps-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ ...appFile, ...extra, ...(tagPrefix === undefined ? {} : { tagPrefix }) }));
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
  assert.match(checkTag("v1.2", "v").stderr, /tags look like v1\.2\.3, or v1\.2\.3-beta\.1 for a beta, not v1\.2/);
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
  assert.match(checkTag("win-v1.2", "v", "win-v").stderr, /tags look like v1\.2\.3 or win-v1\.2\.3, or v1\.2\.3-beta\.1 for a beta, not win-v1\.2/);
});

test("check-tag reads beta tags, with a build below the release's", () => {
  assert.equal(checkTag("v0.8.0-beta.1", "v").stdout, "version=0.8.0-beta.1\nbuild=799901\nprefix=v\n");
  assert.equal(checkTag("win-v1.2.3-beta.12", "v", "win-v").stdout, "version=1.2.3-beta.12\nbuild=100200212\nprefix=win-v\n");
  for (const bad of ["v1.2.3-beta.0", "v1.2.3-beta.100", "v1.2.3-beta", "v1.2.3-rc.1", "v1.2.3-beta.1.2"]) {
    const r = checkTag(bad, "v");
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /tags look like v1\.2\.3, or v1\.2\.3-beta\.1 for a beta/);
  }
  assert.match(checkTag("v0.0.0-beta.1", "v").stderr, /0\.0\.0 can't have a beta/);
});

test("read-config gives the release branches", () => {
  assert.equal(readConfig(undefined).out.release_branches, "");
  assert.equal(readConfig(undefined, { releaseBranches: ["release/*", "hotfix"] }).out.release_branches, "release/* hotfix");
  assert.equal(readConfig(undefined, { releaseBranches: "release/*" }).out.release_branches, "release/*");
  for (const bad of [["*"], ["release/**"], ["re lease"], ["release/*/x"], [7], ["../x/*"]]) {
    const r = readConfig(undefined, { releaseBranches: bad });
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.match(r.stderr, /releaseBranches must be branch names/);
  }
});

test("check-tag takes a tag on main, or on a release branch the app allows", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  mkdirSync(origin);
  mkdirSync(repo);
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "remote", "add", "origin", origin);
  const commit = (message: string) => git(repo, "commit", "--quiet", "--allow-empty", "-m", message);
  commit("first");
  git(repo, "tag", "v1.0.0");
  git(repo, "switch", "--quiet", "-c", "release/1.0");
  commit("fix");
  git(repo, "tag", "v1.0.1");
  git(repo, "switch", "--quiet", "-c", "feature/idea", "main");
  commit("idea");
  git(repo, "tag", "v1.1.0-beta.1");
  git(repo, "push", "--quiet", "origin", "main", "release/1.0", "feature/idea", "--tags");

  const run = (tag: string, branches?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.SKIP_MAIN_CHECK;
    if (branches === undefined) delete env.RELEASE_BRANCHES;
    else env.RELEASE_BRANCHES = branches;
    const r = spawnSync("bash", [script("check-tag.sh"), tag, "v"], { cwd: repo, encoding: "utf8", env });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  assert.equal(run("v1.0.0").code, 0);
  assert.equal(run("v1.0.0", "release/*").code, 0);

  const offMain = run("v1.0.1");
  assert.equal(offMain.code, 1);
  assert.match(offMain.stderr, /which isn't on main; tag a commit on main/);
  const onRelease = run("v1.0.1", "release/*");
  assert.deepEqual([onRelease.code, onRelease.stdout], [0, "version=1.0.1\nbuild=100000100\nprefix=v\n"], onRelease.stderr);
  assert.equal(run("v1.0.1", "hotfix release/1.0").code, 0);
  assert.equal(run("v1.0.1", "release/2.0").code, 1);

  // A branch the app didn't list doesn't count, whatever the tag.
  const elsewhere = run("v1.1.0-beta.1", "release/*");
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, /which isn't on main or a release branch \(release\/\*\); tag a commit on main/);
});
