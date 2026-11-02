import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { workflowTemplate } from "../src/commands/setup.js";
import { loadConfig } from "../src/config.js";
import { SPARKLE_SERVICE } from "../src/secrets.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { harness } from "./helpers.js";

let server: FakeServer;
before(async () => { server = await startFakeServer(); });
after(async () => { await server.close(); });

function ghResponder(policies: { name: string; type: string }[] = []) {
  return (args: string[]): string => {
    if (args[0] === "repo" && args[1] === "view") return "Moulik-Budhiraja/screen-draw\n";
    if (args[0] === "api" && args.length === 2 && args[1]!.endsWith("/deployment-branch-policies")) {
      return JSON.stringify({ total_count: policies.length, branch_policies: policies.map((item, id) => ({ id, ...item })) });
    }
    return "{}";
  };
}

async function setup(gh = ghResponder(), platforms = "mac") {
  const h = await harness({ stdin: `${server.adminToken}\n`, gh });
  const signing = join(h.home, "signing");
  await mkdir(signing);
  await writeFile(join(signing, "developer-id.p12"), Buffer.from([1, 2, 3, 4]));
  await writeFile(join(signing, "certificate-password"), "hunter2\n");
  await writeFile(join(signing, "AuthKey_ABC123XYZ.p8"), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
  await h.run("remote", "add", "moulik", server.url);
  assert.equal((await h.run("login", "moulik", "--token-stdin")).code, 0);
  const name = `init-${Math.random().toString(36).slice(2, 8)}`;
  const created = await h.run("create", name, "--remote", "moulik", "--updater", "sparkle", "--title", "ScreenDraw", "--platforms", platforms);
  assert.equal(created.code, 0, created.stderr);
  return { h, signing, name };
}

test("init --dry-run changes nothing and lists the plan", async () => {
  const { h, signing } = await setup();
  try {
    const before = server.tokens.length;
    const result = await h.run("init", "--dry-run", "--signing-dir", signing);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Dry run: nothing was changed/);
    assert.match(result.stdout, /deployable only from tags matching v\*/);
    assert.match(result.stdout, /APPLE_CERTIFICATE_BASE64, APPLE_CERTIFICATE_PASSWORD, APPLE_API_KEY_BASE64, APPLE_KEY_ID, APPLE_ISSUER_ID, APPS_TOKEN, SPARKLE_PRIVATE_KEY/);
    assert.match(result.stdout, /would ask for the issuer ID/);
    assert.match(result.stdout, /SUPublicEDKey  [A-Za-z0-9+/]{43}=/);
    // Only the read-only repo lookup ran.
    assert.deepEqual(h.gh.calls.map((call) => call.args.slice(0, 2)), [["repo", "view"], ["api", "repos/Moulik-Budhiraja/screen-draw"]]);
    assert.equal(server.tokens.length, before);
    await assert.rejects(access(join(h.dir, ".github/workflows/release.yml")));
    assert.equal((await loadConfig(h.deps.env)).appleIssuerId, undefined);

    const json = JSON.parse((await h.run("init", "--dry-run", "--signing-dir", signing, "--repo", "me/thing", "--json")).stdout);
    assert.equal(json.repo, "me/thing");
    assert.equal(json.appleKeyId, "ABC123XYZ");
    assert.equal(json.workflow.write, true);
  } finally {
    await h.cleanup();
  }
});

test("init sets up the environment, secrets via stdin, token and workflow", async () => {
  const { h, signing, name } = await setup();
  try {
    h.answers.push("issuer-1234");
    const result = await h.run("init", "--signing-dir", signing);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Moulik-Budhiraja\/screen-draw is ready to release/);

    const calls = h.gh.calls.map((call) => ({ args: call.args, input: call.options?.input }));
    const env = calls.find((call) => call.args.includes("PUT"))!;
    assert.deepEqual(env.args, ["api", "-X", "PUT", "repos/Moulik-Budhiraja/screen-draw/environments/production", "--input", "-"]);
    assert.deepEqual(JSON.parse(env.input!), { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    const policy = calls.find((call) => call.args.includes("POST"))!;
    assert.deepEqual(JSON.parse(policy.input!), { name: "v*", type: "tag" });

    const secrets = Object.fromEntries(
      calls.filter((call) => call.args[0] === "secret").map((call) => [call.args[2], call.input]),
    );
    const key = await h.secrets.get(SPARKLE_SERVICE, `moulik/${name}`);
    const token = server.tokens.find((item) => item.app === name)!;
    assert.deepEqual(secrets, {
      APPLE_CERTIFICATE_BASE64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      APPLE_CERTIFICATE_PASSWORD: "hunter2",
      APPLE_API_KEY_BASE64: Buffer.from("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n").toString("base64"),
      APPLE_KEY_ID: "ABC123XYZ",
      APPLE_ISSUER_ID: "issuer-1234",
      APPS_TOKEN: token.token,
      SPARKLE_PRIVATE_KEY: key,
    });
    // Secret values never appear in argv.
    for (const call of calls) {
      for (const value of Object.values(secrets)) assert.ok(!call.args.includes(value!), `secret leaked into argv: ${call.args.join(" ")}`);
    }
    for (const call of calls.filter((item) => item.args[0] === "secret")) {
      assert.deepEqual(call.args.slice(3), ["--repo", "Moulik-Budhiraja/screen-draw", "--env", "production"]);
    }
    assert.equal(token.label, "github-actions Moulik-Budhiraja/screen-draw");
    assert.equal(await readFile(join(h.dir, ".github/workflows/release.yml"), "utf8"), workflowTemplate("v"));
    assert.equal((await loadConfig(h.deps.env)).appleIssuerId, "issuer-1234");

    // Run again: the issuer comes from config, the old token is revoked, the workflow is kept.
    const firstId = token.id;
    const second = await h.run("init", "--signing-dir", signing);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Revoked 1 older publish token/);
    assert.match(second.stdout, /Kept the existing/);
    const remaining = server.tokens.filter((item) => item.app === name);
    assert.equal(remaining.length, 1);
    assert.notEqual(remaining[0]!.id, firstId);
  } finally {
    await h.cleanup();
  }
});

test("init requires approval for fork pull requests on a public repo", async () => {
  const responder = ghResponder();
  const { h, signing } = await setup((args) => (args[0] === "api" && args[1] === "repos/me/open" ? '{"private":false}' : responder(args)));
  try {
    const dry = await h.run("init", "--dry-run", "--signing-dir", signing, "--repo", "me/open");
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /require approval for workflows from every external contributor/);
    assert.match(dry.stdout, /publicRepositories/);
    assert.ok(!h.gh.calls.some((call) => call.args.includes("PUT")), "a dry run changes nothing");

    const result = await h.run("init", "--signing-dir", signing, "--repo", "me/open", "--apple-issuer-id", "issuer-x");
    assert.equal(result.code, 0, result.stderr);
    const approval = h.gh.calls.find((call) => call.args.includes("repos/me/open/actions/permissions/fork-pr-contributor-approval"))!;
    assert.deepEqual(approval.args.slice(0, 3), ["api", "-X", "PUT"]);
    assert.deepEqual(JSON.parse(approval.options!.input!), { approval_policy: "all_external_contributors" });
    assert.match(result.stdout, /publicRepositories/);
  } finally {
    await h.cleanup();
  }
});

test("init leaves fork approval alone on a private repo", async () => {
  const responder = ghResponder();
  const { h, signing } = await setup((args) => (args[0] === "api" && args[1] === "repos/me/closed" ? '{"private":true}' : responder(args)));
  try {
    const result = await h.run("init", "--signing-dir", signing, "--repo", "me/closed", "--apple-issuer-id", "issuer-x");
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!h.gh.calls.some((call) => call.args.some((arg) => arg.includes("fork-pr-contributor-approval"))));
    assert.doesNotMatch(result.stdout, /publicRepositories/);
  } finally {
    await h.cleanup();
  }
});

test("init skips an existing tag policy and revokes the new token when gh fails", async () => {
  let failSecrets = false;
  const base = ghResponder([{ name: "v*", type: "tag" }]);
  const { h, signing, name } = await setup((args) => {
    if (failSecrets && args[0] === "secret") throw new Error("gh secret set failed: HTTP 403");
    return base(args);
  });
  try {
    failSecrets = true;
    const result = await h.run("init", "--signing-dir", signing, "--apple-issuer-id", "issuer-x");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /HTTP 403/);
    assert.ok(!h.gh.calls.some((call) => call.args.includes("POST")), "existing policy should not be re-added");
    assert.equal(server.tokens.filter((item) => item.app === name).length, 0, "token should be revoked after a failure");
  } finally {
    await h.cleanup();
  }
});

test("init refuses without signing files or with several API keys", async () => {
  const { h, signing } = await setup();
  try {
    const missing = await h.run("init", "--dry-run", "--signing-dir", join(h.home, "nowhere"));
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Missing signing files .*developer-id\.p12, certificate-password, AuthKey_<key id>\.p8/);
    await writeFile(join(signing, "AuthKey_SECOND.p8"), "x");
    const several = await h.run("init", "--dry-run", "--signing-dir", signing);
    assert.equal(several.code, 2);
    assert.match(several.stderr, /Pass --key-id/);
    assert.equal((await h.run("init", "--dry-run", "--signing-dir", signing, "--key-id", "SECOND")).code, 0);
  } finally {
    await h.cleanup();
  }
});

const azureSigning = {
  tenantId: "tenant-1",
  clientId: "client-1",
  clientSecret: "client-secret-1",
  endpoint: "https://eus.codesigning.azure.net",
  account: "moulik-signing",
  profile: "public-trust",
  publisher: "Moulik Budhiraja",
};

function secretsSet(calls: { args: string[]; options?: { input?: string } }[]): Record<string, string | undefined> {
  return Object.fromEntries(calls.filter((call) => call.args[0] === "secret").map((call) => [call.args[2], call.options?.input]));
}

test("init for macOS and Windows sets both platforms' secrets and a job for each", async () => {
  const { h, signing, name } = await setup(ghResponder(), "mac,windows");
  try {
    await writeFile(join(signing, "azure-signing.json"), JSON.stringify(azureSigning));
    const dry = await h.run("init", "--dry-run", "--signing-dir", signing);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /APPLE_ISSUER_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE, AZURE_SIGNING_PUBLISHER, APPS_TOKEN, SPARKLE_PRIVATE_KEY/);
    assert.match(dry.stdout, /Artifact Signing settings from .*azure-signing\.json/);
    assert.match(dry.stdout, /win_sparkle_set_appcast_url\(".*\/appcast-windows\.xml"\)/);
    assert.match(dry.stdout, /SUFeedURL/);
    assert.doesNotMatch(dry.stdout, /client-secret-1/);

    const result = await h.run("init", "--signing-dir", signing, "--apple-issuer-id", "issuer-x", "--json");
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.deepEqual(json.platforms, ["mac", "windows"]);
    assert.match(json.feeds.windows, /appcast-windows\.xml$/);
    const secrets = secretsSet(h.gh.calls);
    assert.equal(secrets.APPLE_ISSUER_ID, "issuer-x");
    assert.equal(secrets.AZURE_TENANT_ID, "tenant-1");
    assert.equal(secrets.AZURE_CLIENT_SECRET, "client-secret-1");
    assert.equal(secrets.AZURE_SIGNING_PUBLISHER, "Moulik Budhiraja");
    assert.equal(secrets.APPS_TOKEN, server.tokens.find((item) => item.app === name)!.token);
    for (const call of h.gh.calls) assert.ok(!call.args.includes("client-secret-1"), "secret leaked into argv");
    assert.equal(await readFile(join(h.dir, ".github/workflows/release.yml"), "utf8"), workflowTemplate("v", ["mac", "windows"]));
  } finally {
    await h.cleanup();
  }
});

test("init for a Windows-only app needs no Apple files or issuer", async () => {
  const responder = ghResponder();
  const { h, name } = await setup((args) => (args[0] === "api" && args[1] === "repos/me/win" ? '{"private":false}' : responder(args)), "windows");
  try {
    const signing = join(h.home, "windows-signing");
    await mkdir(signing);
    await writeFile(join(signing, "azure-signing.json"), JSON.stringify(azureSigning));
    const result = await h.run("init", "--signing-dir", signing, "--repo", "me/win");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.keys(secretsSet(h.gh.calls)), [
      "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SIGNING_ENDPOINT",
      "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE", "AZURE_SIGNING_PUBLISHER", "APPS_TOKEN", "SPARKLE_PRIVATE_KEY",
    ]);
    assert.equal(h.answers.length, 0);
    assert.equal((await loadConfig(h.deps.env)).appleIssuerId, undefined);
    // A public repo needs fork approval and the Windows runner allowlist, not the macOS one.
    assert.ok(h.gh.calls.some((call) => call.args.includes("repos/me/win/actions/permissions/fork-pr-contributor-approval")));
    assert.doesNotMatch(result.stdout, /publicRepositories/);
    assert.match(result.stdout, /Windows runner controller.s public-repo allowlist/);
    const workflow = await readFile(join(h.dir, ".github/workflows/release.yml"), "utf8");
    // me/win isn't owned by Moulik-Budhiraja, so its jobs run the release action themselves.
    assert.equal(workflow, workflowTemplate("v", ["windows"], "action"));
    assert.match(workflow, /runs-on: \[self-hosted, windows\]\n    environment: production\n/);
    assert.match(workflow, /uses: Moulik-Budhiraja\/app-hosting\/actions\/release-windows@main\n        with:\n          apps-token: \$\{\{ secrets\.APPS_TOKEN \}\}\n          sparkle-private-key: \$\{\{ secrets\.SPARKLE_PRIVATE_KEY \}\}\n          azure-tenant-id: \$\{\{ secrets\.AZURE_TENANT_ID \}\}\n/);
    assert.doesNotMatch(workflow, /^ +secrets: inherit$|toJSON|release-mac/m);
    assert.ok(server.tokens.some((item) => item.app === name));
  } finally {
    await h.cleanup();
  }
});

test("init refuses a Windows build without complete Artifact Signing settings", async () => {
  const { h, signing } = await setup(ghResponder(), "mac,windows");
  try {
    const missing = await h.run("init", "--dry-run", "--signing-dir", signing, "--json");
    assert.equal(missing.code, 2);
    assert.equal(JSON.parse(missing.stderr).error.code, "MISSING_SIGNING_FILES");
    assert.match(JSON.parse(missing.stderr).error.message, /azure-signing\.json.*"tenantId", "clientId"/);

    const { clientSecret: _secret, publisher: _publisher, ...partial } = azureSigning;
    await writeFile(join(signing, "azure-signing.json"), JSON.stringify(partial));
    const incomplete = await h.run("init", "--dry-run", "--signing-dir", signing);
    assert.equal(incomplete.code, 2);
    assert.match(incomplete.stderr, /azure-signing\.json is missing clientSecret, publisher/);

    await writeFile(join(signing, "azure-signing.json"), "[1]");
    const notObject = await h.run("init", "--dry-run", "--signing-dir", signing);
    assert.equal(notObject.code, 2);
    assert.match(notObject.stderr, /isn't a JSON object/);
  } finally {
    await h.cleanup();
  }
});

test("init adds a tag rule for every prefix and keeps the ones already there", async () => {
  const { h, signing } = await setup(ghResponder([{ name: "v*", type: "tag" }]));
  try {
    const path = join(h.dir, "apps.json");
    const file = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...file, tagPrefix: ["v", "win-v"] }, null, 2));

    const dry = JSON.parse((await h.run("init", "--dry-run", "--signing-dir", signing, "--json")).stdout);
    assert.equal(dry.tagPolicy, "v*");
    assert.deepEqual(dry.tagPolicies, ["v*", "win-v*"]);

    const result = await h.run("init", "--signing-dir", signing, "--apple-issuer-id", "issuer-x");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /tags v\*, win-v\*/);
    assert.match(result.stdout, /e\.g\. v1\.0\.0 or win-v1\.0\.0/);
    // v* existed, so only win-v* is added.
    const posted = h.gh.calls
      .filter((call) => call.args.includes("POST") && call.args.some((arg) => arg.endsWith("/deployment-branch-policies")))
      .map((call) => JSON.parse(call.options!.input!));
    assert.deepEqual(posted, [{ name: "win-v*", type: "tag" }]);
    const workflow = await readFile(join(h.dir, ".github/workflows/release.yml"), "utf8");
    assert.match(workflow, /tags: \['v\*', 'win-v\*'\]/);
  } finally {
    await h.cleanup();
  }
});
