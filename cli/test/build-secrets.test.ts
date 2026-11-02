// Tests scripts/common/with-build-secrets.mjs, which the release workflows use
// to hand an app's build secrets to its build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const wrapper = fileURLToPath(new URL("../../scripts/common/with-build-secrets.mjs", import.meta.url));
// The child prints the variables it got that the tests care about.
const printEnv = `const e = process.env; console.log(JSON.stringify(Object.fromEntries(Object.keys(e).filter(k => /^(APPS_|FOO|BAR|LOWER|OTHER|PEM)/i.test(k)).map(k => [k, e[k]]))))`;

function run(names: string, secrets: Record<string, string> | string, extraEnv: Record<string, string> = {}, child = ["-e", printEnv]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(APPS_|FOO|BAR|LOWER|OTHER|PEM)/i.test(k)) env[k] = v;
  }
  Object.assign(env, extraEnv, {
    APPS_BUILD_SECRETS: names,
    APPS_SECRETS_JSON: typeof secrets === "string" ? secrets : JSON.stringify(secrets),
  });
  return spawnSync(process.execPath, [wrapper, process.execPath, ...child], { env, encoding: "utf8" });
}

const secrets = {
  github_token: "ghs_token",
  APPS_TOKEN: "apps-token-value",
  FOO: "foo-value",
  BAR: "bar-value",
  OTHER: "other-value",
  PEM: "-----BEGIN KEY-----\nline \"two\" \\ end\n-----END KEY-----",
};

test("hands the build only the listed secrets", () => {
  const r = run("FOO, BAR\nPEM", secrets);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { FOO: "foo-value", BAR: "bar-value", PEM: secrets.PEM });
  assert.match(r.stderr, /Build secrets: FOO, BAR, PEM/);
  for (const value of Object.values(secrets)) assert.ok(!r.stderr.includes(value));
});

test("matches secret names case-insensitively and exports the name as written", () => {
  const r = run("foo", secrets);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { foo: "foo-value" });
});

test("fails without printing values when a listed secret isn't set", () => {
  const r = run("FOO MISSING EMPTY", { ...secrets, EMPTY: "" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /MISSING isn't set/);
  assert.match(r.stderr, /EMPTY isn't set/);
  assert.ok(!r.stderr.includes("foo-value"));
});

test("rejects bad names and names the build step already sets", () => {
  const r = run("1BAD FOO-BAR LOWERCASE", secrets, { lowercase: "already here" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"1BAD" isn't a valid secret name/);
  assert.match(r.stderr, /"FOO-BAR" isn't a valid secret name/);
  assert.match(r.stderr, /LOWERCASE would replace a variable/);
});

test("doesn't echo unparseable secrets", () => {
  const r = run("FOO", '{"FOO": "secret-fragment');
  assert.equal(r.status, 1);
  assert.ok(!r.stderr.includes("secret-fragment"));
});

test("passes the build's exit code through", () => {
  const r = run("FOO", secrets, {}, ["-e", "process.exit(7)"]);
  assert.equal(r.status, 7);
});
