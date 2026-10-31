import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ApiError, type AppInfo } from "../api.js";
import {
  appFileExists,
  checkAppName,
  defaultBuildSection,
  readAppFile,
  titleFromName,
  writeAppFile,
  type AppFile,
  type Updater,
} from "../appfile.js";
import { getRemote, loadConfig, saveConfig } from "../config.js";
import { client, requireAdmin, type Deps, type Out } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import { generateSparkleKeys, publicKeyFor } from "../sparkle.js";
import { SPARKLE_SERVICE, sparkleAccount } from "../secrets.js";

export const ENVIRONMENT = "production";
export const WORKFLOW_PATH = ".github/workflows/release.yml";

export function workflowTemplate(tagPrefix: string): string {
  return `name: Release
on:
  push:
    tags: ['${tagPrefix}*']
jobs:
  release:
    uses: Moulik-Budhiraja/app-hosting/.github/workflows/release-mac.yml@main
    secrets: inherit
`;
}

export function feedUrl(file: Pick<AppFile, "app" | "remote" | "updater">): string {
  const base = `${file.remote.url}/${file.app}`;
  return file.updater === "sparkle" ? `${base}/appcast.xml` : `${base}/latest-mac.yml`;
}

/** What the app itself must contain to find its updates. */
export function integrationLines(file: Pick<AppFile, "app" | "remote" | "updater">, publicKey?: string): string[] {
  const base = `${file.remote.url}/${file.app}`;
  if (file.updater === "sparkle") {
    return [
      "The app needs Sparkle, with these Info.plist keys:",
      `  SUFeedURL      ${base}/appcast.xml`,
      `  SUPublicEDKey  ${publicKey ?? "(run apps init on the Mac that ran apps create)"}`,
      "and an SPUStandardUpdaterController started at launch.",
      `Download page: ${base}/`,
    ];
  }
  return [
    "Point electron-builder at the remote:",
    `  publish: { provider: generic, url: ${base}/ }`,
    "and call autoUpdater.checkForUpdatesAndNotify() from electron-updater.",
    `Download page: ${base}/`,
  ];
}

async function sparkleKey(deps: Deps, remote: string, app: string): Promise<string | null> {
  const fromEnv = deps.env.SPARKLE_PRIVATE_KEY?.trim();
  if (fromEnv) return fromEnv;
  return deps.secrets.get(SPARKLE_SERVICE, sparkleAccount(remote, app));
}

export async function createCommand(
  deps: Deps,
  out: Out,
  positionals: string[],
  options: { dir: string; remote?: string; updater?: string; title?: string; kind?: string },
): Promise<void> {
  if (positionals.length !== 1) {
    throw usage("Usage: apps create <app> --remote <remote> --updater sparkle|electron [--title T] [--kind native|electron]");
  }
  const name = checkAppName(positionals[0]!);
  if (!options.remote) throw usage("Pass --remote <remote>. Each app lives on exactly one remote.");
  if (options.updater !== "sparkle" && options.updater !== "electron") {
    throw usage("Pass --updater sparkle (native apps) or --updater electron.");
  }
  const updater: Updater = options.updater;
  const kind = (options.kind ?? (updater === "sparkle" ? "native" : "electron")) as "native" | "electron";
  if (kind !== "native" && kind !== "electron") throw usage("--kind must be native or electron.");
  if ((kind === "native") !== (updater === "sparkle")) {
    throw usage("Native builds use --updater sparkle; electron builds use --updater electron.");
  }
  if (await appFileExists(options.dir)) {
    throw new CliError(`${join(options.dir, "apps.json")} already exists. This repo already has an app.`, EXIT.usage, "APPS_JSON_EXISTS");
  }

  const remote = getRemote(await loadConfig(deps.env), options.remote);
  const api = await client(deps, options.remote, remote.url);
  const title = options.title?.trim() || titleFromName(name);

  let publicKey: string | undefined;
  let createdKey = false;
  if (updater === "sparkle") {
    const account = sparkleAccount(options.remote, name);
    const existing = await deps.secrets.get(SPARKLE_SERVICE, account);
    if (existing) {
      publicKey = publicKeyFor(existing);
      out.info(`Using the Sparkle key already in the keychain for ${account}.`);
    } else {
      const keys = generateSparkleKeys();
      await deps.secrets.set(SPARKLE_SERVICE, account, keys.privateKey);
      publicKey = keys.publicKey;
      createdKey = true;
    }
  }

  let app: AppInfo;
  let adopted = false;
  try {
    app = await api.createApp({ name, title, updater, ...(publicKey ? { sparklePublicKey: publicKey } : {}) });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) {
      if (createdKey) await deps.secrets.delete(SPARKLE_SERVICE, sparkleAccount(options.remote, name)).catch(() => false);
      throw error;
    }
    // Already there: fine if it's the same app (a re-run after a partial failure).
    app = await api.getApp(name);
    if (app.updater !== updater || (publicKey && app.sparklePublicKey !== publicKey)) {
      throw new CliError(
        `${name} already exists on ${options.remote} with a different ${app.updater !== updater ? "updater" : "Sparkle key"}. Pick another name.`,
        EXIT.failure,
        "APP_EXISTS",
      );
    }
    adopted = true;
  }

  const file: AppFile = {
    app: name,
    remote: { name: options.remote, url: remote.url },
    updater,
    tagPrefix: "v",
    build: defaultBuildSection(name, title, kind),
  };
  const path = await writeAppFile(options.dir, file);

  out.result(
    [
      `${adopted ? "Found" : "Created"} ${name} on ${options.remote} and wrote ${path}.`,
      "",
      "Next:",
      `  1. Check the "build" section of apps.json matches how this app builds.`,
      "  2. Run apps init to connect the GitHub repo.",
      "",
      ...integrationLines(file, publicKey),
    ],
    { app: { name: app.name, title: app.title, updater: app.updater }, adopted, appsJson: path, file, sparklePublicKey: publicKey ?? null, feed: feedUrl(file) },
  );
}

interface SigningFiles {
  dir: string;
  certificate: string;
  password: string;
  apiKey: string;
  keyId: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string, deps: Deps): string {
  if (path === "~") return deps.env.HOME || homedir();
  if (path.startsWith("~/")) return join(deps.env.HOME || homedir(), path.slice(2));
  return resolve(deps.cwd, path);
}

async function findSigningFiles(dir: string, keyId?: string): Promise<SigningFiles> {
  const certificate = join(dir, "developer-id.p12");
  const password = join(dir, "certificate-password");
  const missing = [];
  if (!(await exists(certificate))) missing.push("developer-id.p12");
  if (!(await exists(password))) missing.push("certificate-password");
  let keys: string[] = [];
  try {
    keys = (await readdir(dir)).filter((name) => /^AuthKey_[A-Za-z0-9]+\.p8$/.test(name));
  } catch {
    // Reported below.
  }
  if (keyId) keys = keys.filter((name) => name === `AuthKey_${keyId}.p8`);
  if (!keys.length) missing.push(keyId ? `AuthKey_${keyId}.p8` : "AuthKey_<key id>.p8");
  if (missing.length) {
    throw new CliError(`Missing signing files in ${dir}: ${missing.join(", ")}. Pass --signing-dir.`, EXIT.usage, "MISSING_SIGNING_FILES");
  }
  if (keys.length > 1) {
    throw new CliError(`${dir} has several App Store Connect keys (${keys.join(", ")}). Pass --key-id.`, EXIT.usage, "AMBIGUOUS_KEY");
  }
  const apiKey = join(dir, keys[0]!);
  return { dir, certificate, password, apiKey, keyId: keys[0]!.slice("AuthKey_".length, -".p8".length) };
}

export interface InitOptions {
  dir: string;
  repo?: string;
  signingDir?: string;
  appleIssuerId?: string;
  keyId?: string;
  dryRun: boolean;
}

export async function initCommand(deps: Deps, out: Out, options: InitOptions): Promise<void> {
  const file = await readAppFile(options.dir);
  const config = await loadConfig(deps.env);

  let repo = options.repo?.trim();
  if (!repo) {
    repo = (await deps.gh.run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: options.dir })).trim();
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw usage(`"${repo}" isn't a GitHub repo. Pass --repo owner/name.`);

  const signing = await findSigningFiles(expandHome(options.signingDir ?? "~/.config/predictor-release", deps), options.keyId);

  let issuer = options.appleIssuerId?.trim() || config.appleIssuerId;
  let saveIssuer = Boolean(options.appleIssuerId?.trim() && options.appleIssuerId.trim() !== config.appleIssuerId);
  if (!issuer && !options.dryRun) {
    issuer = await deps.prompt.line("App Store Connect issuer ID (Users and Access › Integrations › Keys): ");
    saveIssuer = true;
  }
  if (!issuer && !options.dryRun) throw usage("An App Store Connect issuer ID is required. Pass --apple-issuer-id.");

  let privateKey: string | null = null;
  let publicKey: string | undefined;
  if (file.updater === "sparkle") {
    privateKey = await sparkleKey(deps, file.remote.name, file.app);
    if (!privateKey) {
      throw new CliError(
        `No Sparkle key for ${sparkleAccount(file.remote.name, file.app)} in the keychain. Run apps init on the Mac that ran apps create, or set SPARKLE_PRIVATE_KEY.`,
        EXIT.failure,
        "NO_SPARKLE_KEY",
      );
    }
    publicKey = publicKeyFor(privateKey);
  }

  const policy = `${file.tagPrefix}*`;
  const label = `github-actions ${repo}`;
  const workflowPath = join(options.dir, WORKFLOW_PATH);
  const writeWorkflow = !(await exists(workflowPath));
  const secretNames = [
    "APPLE_CERTIFICATE_BASE64",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_API_KEY_BASE64",
    "APPLE_KEY_ID",
    "APPLE_ISSUER_ID",
    "APPS_TOKEN",
    ...(file.updater === "sparkle" ? ["SPARKLE_PRIVATE_KEY"] : []),
  ];
  const summary = {
    repo,
    app: file.app,
    remote: file.remote.name,
    environment: ENVIRONMENT,
    tagPolicy: policy,
    secrets: secretNames,
    signingDir: signing.dir,
    appleKeyId: signing.keyId,
    publishTokenLabel: label,
    workflow: { path: workflowPath, write: writeWorkflow },
    feed: feedUrl(file),
    sparklePublicKey: publicKey ?? null,
  };

  if (options.dryRun) {
    out.result(
      [
        `Dry run: nothing was changed. apps init would:`,
        `  • create or update the "${ENVIRONMENT}" environment on ${repo}, deployable only from tags matching ${policy}`,
        `  • create a publish token for ${file.app} on ${file.remote.name} labelled "${label}" (and revoke older ones with that label)`,
        `  • set environment secrets: ${secretNames.join(", ")}`,
        `    (Apple files from ${signing.dir}, key ${signing.keyId}${issuer ? "" : "; would ask for the issuer ID"})`,
        writeWorkflow ? `  • write ${WORKFLOW_PATH}` : `  • keep the existing ${WORKFLOW_PATH}`,
        "",
        ...integrationLines(file, publicKey),
      ],
      { dryRun: true, ...summary },
    );
    return;
  }

  const api = await client(deps, file.remote.name, file.remote.url);
  await requireAdmin(deps, api);
  const app = await api.getApp(file.app);
  if (app.updater !== file.updater) {
    throw new CliError(`${file.app} on ${file.remote.name} uses ${app.updater}, but apps.json says ${file.updater}.`, EXIT.failure, "MISMATCH");
  }
  if (publicKey && app.sparklePublicKey !== publicKey) {
    throw new CliError(
      `The Sparkle key in the keychain doesn't match ${file.app}'s key on ${file.remote.name}. Releases signed with it would be rejected.`,
      EXIT.failure,
      "SPARKLE_KEY_MISMATCH",
    );
  }

  if (saveIssuer && issuer) {
    config.appleIssuerId = issuer;
    await saveConfig(deps.env, config);
  }

  out.info(`Setting up the ${ENVIRONMENT} environment on ${repo}…`);
  await deps.gh.run(["api", "-X", "PUT", `repos/${repo}/environments/${ENVIRONMENT}`, "--input", "-"], {
    input: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
  });
  const policies = JSON.parse(
    await deps.gh.run(["api", `repos/${repo}/environments/${ENVIRONMENT}/deployment-branch-policies`]),
  ) as { branch_policies?: { id: number; name: string; type?: string }[] };
  if (!policies.branch_policies?.some((item) => item.name === policy && (item.type ?? "branch") === "tag")) {
    await deps.gh.run(["api", "-X", "POST", `repos/${repo}/environments/${ENVIRONMENT}/deployment-branch-policies`, "--input", "-"], {
      input: JSON.stringify({ name: policy, type: "tag" }),
    });
  }

  const previous = (await api.listTokens(file.app)).filter((token) => token.label === label);
  const created = await api.createToken(file.app, label);
  const values: Record<string, string> = {
    APPLE_CERTIFICATE_BASE64: (await readFile(signing.certificate)).toString("base64"),
    APPLE_CERTIFICATE_PASSWORD: (await readFile(signing.password, "utf8")).replace(/[\r\n]+/g, ""),
    APPLE_API_KEY_BASE64: (await readFile(signing.apiKey)).toString("base64"),
    APPLE_KEY_ID: signing.keyId,
    APPLE_ISSUER_ID: issuer!,
    APPS_TOKEN: created.token,
    ...(privateKey ? { SPARKLE_PRIVATE_KEY: privateKey } : {}),
  };
  out.info(`Setting ${secretNames.length} secrets…`);
  try {
    for (const name of secretNames) {
      await deps.gh.run(["secret", "set", name, "--repo", repo, "--env", ENVIRONMENT], { input: values[name]! });
    }
  } catch (error) {
    await api.revokeToken(file.app, created.id).catch(() => undefined);
    throw error;
  }
  for (const old of previous) {
    await api.revokeToken(file.app, old.id).catch((error: Error) => out.warn(`Couldn't revoke old token ${old.id}: ${error.message}`));
  }

  if (writeWorkflow) {
    await mkdir(join(options.dir, ".github", "workflows"), { recursive: true });
    await writeFile(workflowPath, workflowTemplate(file.tagPrefix), { flag: "wx" });
  }

  out.result(
    [
      `${repo} is ready to release ${file.app} to ${file.remote.name}.`,
      `  Environment: ${ENVIRONMENT} (tags ${policy}), ${secretNames.length} secrets set`,
      writeWorkflow ? `  Wrote ${WORKFLOW_PATH}. Commit it.` : `  Kept the existing ${WORKFLOW_PATH}.`,
      `  Release by pushing a tag on main, e.g. ${file.tagPrefix}1.0.0`,
      previous.length ? `  Revoked ${previous.length} older publish token${previous.length === 1 ? "" : "s"}.` : "",
      "",
      ...integrationLines(file, publicKey),
    ].filter((line, index, lines) => line !== "" || lines[index - 1] !== ""),
    { dryRun: false, ...summary, tokenId: created.id, revokedTokens: previous.map((token) => token.id) },
  );
}
