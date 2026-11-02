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

const buildEnvScript = fileURLToPath(new URL("../../scripts/common/build-env.mjs", import.meta.url));
const pem = "-----BEGIN KEY-----\nline \"two\" \\ end % 100%0A\n-----END KEY-----";

test("build-env hands the build its NAME=value and NAME<<DELIMITER values only", () => {
  const buildEnv = `FOO=foo-value=with=equals\r\n\nPEM<<EOF_PEM\n${pem}\nEOF_PEM\n  BAR=bar value  \n`;
  const r = run("", {}, { APPS_BUILD_ENV: buildEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { FOO: "foo-value=with=equals", PEM: pem, BAR: "bar value  " });
  assert.match(r.stderr, /Build secrets: FOO, PEM, BAR/);
  assert.ok(!r.stderr.includes("foo-value") && !r.stderr.includes("BEGIN KEY"));
});

test("build-env and the deprecated build-secrets work together", () => {
  const r = run("BAR", secrets, { APPS_BUILD_ENV: "FOO=from-env" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { FOO: "from-env", BAR: "bar-value" });
  const both = run("FOO", secrets, { APPS_BUILD_ENV: "FOO=from-env" });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /FOO comes from both build-env and build-secrets/);
});

test("bad build-env fails without printing any of it", () => {
  // A multi-line secret pasted after NAME= leaves lines that aren't NAME=value.
  const r = run("", {}, { APPS_BUILD_ENV: `PEM=${pem}\nEMPTY=\nFOO=a\nfoo=b\nOPEN<<NEVER\nsecret-tail` });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /build-env line 2 isn't NAME=value or NAME<<DELIMITER/);
  assert.match(r.stderr, /EMPTY an empty value/);
  assert.match(r.stderr, /sets foo twice/);
  assert.match(r.stderr, /OPEN has no closing NEVER line/);
  for (const fragment of ["two", "END KEY", "secret-tail"]) assert.ok(!r.stderr.includes(fragment), fragment);
  const clash = run("", {}, { APPS_BUILD_ENV: "LOWERCASE=x", lowercase: "already here" });
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /LOWERCASE would replace a variable/);
});

test("build-env.mjs mask hides every value line, escaped as a workflow command", () => {
  const r = spawnSync(process.execPath, [buildEnvScript, "mask"], {
    env: { ...process.env, APPS_BUILD_ENV: `FOO=foo%value\nPEM<<EOF_PEM\n${pem}\nEOF_PEM` },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "::add-mask::foo%25value",
    "::add-mask::-----BEGIN KEY-----",
    "::add-mask::line \"two\" \\ end %25 100%250A",
    "::add-mask::-----END KEY-----",
    "Build env: FOO, PEM",
  ]);
  const bad = spawnSync(process.execPath, [buildEnvScript, "mask"], { env: { ...process.env, APPS_BUILD_ENV: "not a line" }, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
});

test("build-env.mjs from-secrets turns build-secrets names into build-env", () => {
  const r = spawnSync(process.execPath, [buildEnvScript, "from-secrets"], {
    env: { ...process.env, APPS_BUILD_SECRETS: "FOO, pem", APPS_SECRETS_JSON: JSON.stringify(secrets) },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const match = /^build_env<<(APPS_OUTPUT_[0-9a-f]+)\n([\s\S]*)\n\1\n$/.exec(r.stdout);
  assert.ok(match, r.stdout);
  // The text it wrote is what the build then gets.
  const back = run("", {}, { APPS_BUILD_ENV: match[2]! });
  assert.equal(back.status, 0, back.stderr);
  assert.deepEqual(JSON.parse(back.stdout), { FOO: "foo-value", pem: secrets.PEM });

  const missing = spawnSync(process.execPath, [buildEnvScript, "from-secrets"], {
    env: { ...process.env, APPS_BUILD_SECRETS: "NOPE", APPS_SECRETS_JSON: JSON.stringify(secrets) },
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /build-secrets: NOPE isn't set/);
});
