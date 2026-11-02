import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ApiError, type AppInfo } from "../api.js";
import {
  appFileExists,
  checkAppName,
  defaultBuildSection,
  feedName,
  isPlatform,
  PLATFORMS,
  platformsOf,
  readAppFile,
  tagPrefixes,
  titleFromName,
  writeAppFile,
  type AppFile,
  type Builds,
  type Platform,
  type Updater,
} from "../appfile.js";
import { getRemote, loadConfig, saveConfig } from "../config.js";
import { client, requireAdmin, type Deps, type Out } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import { generateSparkleKeys, publicKeyFor } from "../sparkle.js";
import { SPARKLE_SERVICE, sparkleAccount } from "../secrets.js";

export const ENVIRONMENT = "production";
export const WORKFLOW_PATH = ".github/workflows/release.yml";

/** The account that owns app-hosting and its reusable workflows. */
export const TOOLING_OWNER = "Moulik-Budhiraja";

/**
 * How an app repo calls the release steps. GitHub's `secrets: inherit` only
 * reaches a reusable workflow owned by the same account or organization, so
 * repos owned by anyone else call the composite actions from their own jobs.
 */
export type WorkflowForm = "reusable" | "action";

export function workflowForm(repo: string): WorkflowForm {
  return repo.split("/")[0]!.toLowerCase() === TOOLING_OWNER.toLowerCase() ? "reusable" : "action";
}

const RUNNERS: Record<Platform, string> = { mac: "[self-hosted, macos-ephemeral]", windows: "[self-hosted, windows]" };

/** The secrets each release action takes as its own inputs: [input, secret name]. */
export function actionSecretInputs(platform: Platform, updater: Updater): [string, string][] {
  const signing: [string, string][] = platform === "mac"
    ? [["apple-certificate-base64", "APPLE_CERTIFICATE_BASE64"], ["apple-certificate-password", "APPLE_CERTIFICATE_PASSWORD"],
      ["apple-api-key-base64", "APPLE_API_KEY_BASE64"], ["apple-key-id", "APPLE_KEY_ID"], ["apple-issuer-id", "APPLE_ISSUER_ID"]]
    : [["azure-tenant-id", "AZURE_TENANT_ID"], ["azure-client-id", "AZURE_CLIENT_ID"], ["azure-client-secret", "AZURE_CLIENT_SECRET"],
      ["azure-signing-endpoint", "AZURE_SIGNING_ENDPOINT"], ["azure-signing-account", "AZURE_SIGNING_ACCOUNT"],
      ["azure-signing-profile", "AZURE_SIGNING_PROFILE"], ["azure-signing-publisher", "AZURE_SIGNING_PUBLISHER"]];
  return [["apps-token", "APPS_TOKEN"], ...(updater === "sparkle" ? [["sparkle-private-key", "SPARKLE_PRIVATE_KEY"] as [string, string]] : []), ...signing];
}

/** The app repo's release.yml: one job per platform. */
export function workflowTemplate(
  tagPrefix: string | readonly string[],
  platforms: readonly Platform[] = ["mac"],
  form: WorkflowForm = "reusable",
  updater: Updater = "sparkle",
): string {
  const tags = (typeof tagPrefix === "string" ? [tagPrefix] : tagPrefix).map((prefix) => `'${prefix}*'`).join(", ");
  if (form === "reusable") {
    const jobs = platforms.map((platform) => `  ${platform}:
    uses: ${TOOLING_OWNER}/app-hosting/.github/workflows/release-${platform}.yml@main
    secrets: inherit
`);
    return `name: Release
on:
  push:
    tags: [${tags}]
jobs:
${jobs.join("")}`;
  }
  const jobs = platforms.map((platform) => `  ${platform}:
    runs-on: ${RUNNERS[platform]}
    environment: production
    timeout-minutes: 90
    concurrency:
      group: release-${platform}-\${{ github.repository }}
      cancel-in-progress: false
    steps:
      - uses: ${TOOLING_OWNER}/app-hosting/actions/release-${platform}@main
        with:
${actionSecretInputs(platform, updater).map(([input, name]) => `          ${input}: \${{ secrets.${name} }}\n`).join("")}`);
  return `# This repo isn't owned by ${TOOLING_OWNER}, so it runs the release actions in
# its own jobs: secrets: inherit doesn't reach another owner's reusable workflow.
# Each job passes the secrets it needs from this repo's production environment.
# If the build needs secrets of its own, add them to a job's with: block as
#   build-env: |
#     NAME=\${{ secrets.NAME }}
name: Release
on:
  push:
    tags: [${tags}]
permissions:
  contents: read
jobs:
${jobs.join("\n")}`;
}

export function feedUrl(file: Pick<AppFile, "app" | "remote" | "updater">, platform: Platform = "mac"): string {
  return `${file.remote.url}/${file.app}/${feedName(file.updater, platform)}`;
}

/** Each built platform's feed URL. */
export function feedUrls(file: Pick<AppFile, "app" | "remote" | "updater" | "builds">): Partial<Record<Platform, string>> {
  return Object.fromEntries(platformsOf(file).map((platform) => [platform, feedUrl(file, platform)]));
}

/** What the app itself must contain to find its updates, for each platform it builds. */
export function integrationLines(file: Pick<AppFile, "app" | "remote" | "updater" | "builds">, publicKey?: string): string[] {
  const base = `${file.remote.url}/${file.app}`;
  const platforms = platformsOf(file);
  const key = publicKey ?? "(run apps init on the Mac that ran apps create)";
  const lines: string[] = [];
  if (file.updater === "sparkle") {
    if (platforms.includes("mac")) {
      lines.push(
        "On macOS the app needs Sparkle, with these Info.plist keys:",
        `  SUFeedURL      ${feedUrl(file, "mac")}`,
        `  SUPublicEDKey  ${key}`,
        "and an SPUStandardUpdaterController started at launch.",
      );
    }
    if (platforms.includes("windows")) {
      lines.push(
        "On Windows the app needs WinSparkle, set up at launch with:",
        `  win_sparkle_set_appcast_url("${feedUrl(file, "windows")}")`,
        `  win_sparkle_set_eddsa_public_key("${key}")`,
        "  win_sparkle_init()",
        "and must report its version as X.Y.Z (its FileVersion, or win_sparkle_set_app_details).",
      );
    }
  } else {
    lines.push(
      "Point electron-builder at the remote:",
      `  publish: { provider: generic, url: ${base}/ }`,
      "and call autoUpdater.checkForUpdatesAndNotify() from electron-updater.",
      "With electron-builder 26, set the version with npm version $VERSION --no-git-tag-version --allow-same-version",
      "  ($env:VERSION on Windows) or --config.extraMetadata.version=$VERSION. It reads -c.extraMetadata.version=…",
      "  as a config path.",
    );
    if (platforms.includes("windows")) {
      lines.push(
        "On Windows, build an NSIS installer signed with Artifact Signing:",
        "  win: { target: nsis, azureSignOptions: { endpoint, codeSigningAccountName, certificateProfileName, publisherName } }",
        "  filled from AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE and AZURE_SIGNING_PUBLISHER.",
        "  Put it in electron-builder.config.js, which reads them from process.env, and pass that file to the build",
        "  with --config electron-builder.config.js. electron-builder doesn't load it on its own, and without it the",
        "  installer comes out unsigned, with the default artifact name.",
      );
    }
  }
  lines.push(`Download page: ${base}/`);
  return lines;
}

/** --platforms mac,windows → the platforms, in a fixed order. Defaults to macOS. */
export function parsePlatforms(value: string | undefined): Platform[] {
  if (value === undefined) return ["mac"];
  const names = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!names.length) throw usage("--platforms needs at least one of mac and windows.");
  for (const name of names) {
    if (!isPlatform(name)) throw usage(`"${name}" isn't a platform. Use --platforms mac, windows or mac,windows.`);
  }
  return PLATFORMS.filter((platform) => names.includes(platform));
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
  options: { dir: string; remote?: string; updater?: string; title?: string; kind?: string; platforms?: string },
): Promise<void> {
  if (positionals.length !== 1) {
    throw usage("Usage: apps create <app> --remote <remote> --updater sparkle|electron [--title T] [--kind native|electron] [--platforms mac,windows]");
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
  const platforms = parsePlatforms(options.platforms);
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
    builds: Object.fromEntries(platforms.map((platform) => [platform, defaultBuildSection(name, title, kind, platform)])) as Builds,
  };
  const path = await writeAppFile(options.dir, file);

  out.result(
    [
      `${adopted ? "Found" : "Created"} ${name} on ${options.remote} and wrote ${path}.`,
      "",
      "Next:",
      `  1. Check the "builds" section of apps.json matches how this app builds.`,
      "  2. Run apps init to connect the GitHub repo.",
      "",
      ...integrationLines(file, publicKey),
    ],
    { app: { name: app.name, title: app.title, updater: app.updater }, adopted, appsJson: path, file, sparklePublicKey: publicKey ?? null, feed: feedUrl(file, platforms[0]), feeds: feedUrls(file) },
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

/** Artifact Signing settings for Windows builds, from <signing-dir>/azure-signing.json. */
export const AZURE_SIGNING_FILE = "azure-signing.json";
const AZURE_FIELDS = {
  tenantId: "AZURE_TENANT_ID",
  clientId: "AZURE_CLIENT_ID",
  clientSecret: "AZURE_CLIENT_SECRET",
  endpoint: "AZURE_SIGNING_ENDPOINT",
  account: "AZURE_SIGNING_ACCOUNT",
  profile: "AZURE_SIGNING_PROFILE",
  publisher: "AZURE_SIGNING_PUBLISHER",
} as const;

interface AzureSigning {
  path: string;
  /** Secret name → value. */
  secrets: Record<string, string>;
}

async function readAzureSigning(dir: string): Promise<AzureSigning> {
  const path = join(dir, AZURE_SIGNING_FILE);
  const shape = `{${Object.keys(AZURE_FIELDS).map((key) => `"${key}"`).join(", ")}}`;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new CliError(
      `Missing ${path}. Windows builds sign with Artifact Signing; put its settings there as ${shape}, or pass --signing-dir.`,
      EXIT.usage,
      "MISSING_SIGNING_FILES",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    throw new CliError(`${path} isn't a JSON object like ${shape}.`, EXIT.usage, "BAD_SIGNING_FILE");
  }
  const missing = Object.keys(AZURE_FIELDS).filter((key) => typeof parsed[key] !== "string" || !(parsed[key] as string).trim());
  if (missing.length) {
    throw new CliError(`${path} is missing ${missing.join(", ")}.`, EXIT.usage, "BAD_SIGNING_FILE");
  }
  const secrets = Object.fromEntries(
    Object.entries(AZURE_FIELDS).map(([key, secret]) => [secret, (parsed[key] as string).trim()]),
  );
  return { path, secrets };
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

  const platforms = platformsOf(file);
  const signingDir = expandHome(options.signingDir ?? "~/.config/predictor-release", deps);
  const signing = platforms.includes("mac") ? await findSigningFiles(signingDir, options.keyId) : null;
  const azure = platforms.includes("windows") ? await readAzureSigning(signingDir) : null;

  // Release jobs run on self-hosted runners, so a public repo must not let fork
  // pull requests run workflows without approval. Both runner pools also serve
  // public repos only from an allowlist.
  const visibility = JSON.parse(
    (await deps.gh.run(["api", `repos/${repo}`, "--jq", "{private: .private}"])) || "{}",
  ) as { private?: boolean };
  const isPublic = visibility.private === false;

  let issuer = options.appleIssuerId?.trim() || config.appleIssuerId;
  let saveIssuer = Boolean(signing && options.appleIssuerId?.trim() && options.appleIssuerId.trim() !== config.appleIssuerId);
  if (signing && !issuer && !options.dryRun) {
    issuer = await deps.prompt.line("App Store Connect issuer ID (Users and Access › Integrations › Keys): ");
    saveIssuer = true;
  }
  if (signing && !issuer && !options.dryRun) throw usage("An App Store Connect issuer ID is required. Pass --apple-issuer-id.");

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

  const prefixes = tagPrefixes(file);
  const tagPolicies = prefixes.map((prefix) => `${prefix}*`);
  const policy = tagPolicies.join(", ");
  const label = `github-actions ${repo}`;
  const workflowPath = join(options.dir, WORKFLOW_PATH);
  const writeWorkflow = !(await exists(workflowPath));
  const form = workflowForm(repo);
  const secretNames = [
    ...(signing ? ["APPLE_CERTIFICATE_BASE64", "APPLE_CERTIFICATE_PASSWORD", "APPLE_API_KEY_BASE64", "APPLE_KEY_ID", "APPLE_ISSUER_ID"] : []),
    ...(azure ? Object.keys(azure.secrets) : []),
    "APPS_TOKEN",
    ...(file.updater === "sparkle" ? ["SPARKLE_PRIVATE_KEY"] : []),
  ];
  const summary = {
    repo,
    app: file.app,
    remote: file.remote.name,
    environment: ENVIRONMENT,
    tagPolicy: tagPolicies[0],
    tagPolicies,
    platforms,
    secrets: secretNames,
    signingDir,
    appleKeyId: signing?.keyId ?? null,
    azureSigning: azure?.path ?? null,
    publishTokenLabel: label,
    workflow: { path: workflowPath, write: writeWorkflow, form },
    feed: feedUrl(file, platforms[0]),
    feeds: feedUrls(file),
    sparklePublicKey: publicKey ?? null,
  };

  if (options.dryRun) {
    out.result(
      [
        `Dry run: nothing was changed. apps init would:`,
        `  • create or update the "${ENVIRONMENT}" environment on ${repo}, deployable only from tags matching ${policy}`,
        `  • create a publish token for ${file.app} on ${file.remote.name} labelled "${label}" (and revoke older ones with that label)`,
        `  • set environment secrets: ${secretNames.join(", ")}`,
        ...(signing ? [`    (Apple files from ${signing.dir}, key ${signing.keyId}${issuer ? "" : "; would ask for the issuer ID"})`] : []),
        ...(azure ? [`    (Artifact Signing settings from ${azure.path})`] : []),
        writeWorkflow
          ? `  • write ${WORKFLOW_PATH}, ${form === "reusable" ? "calling the reusable workflows" : `running the release actions in its own jobs (${repo.split("/")[0]} isn't ${TOOLING_OWNER})`}`
          : `  • keep the existing ${WORKFLOW_PATH}`,
        ...(isPublic ? [`  • require approval for workflows from every external contributor's fork pull request`] : []),
        ...(isPublic ? ["", ...publicRepoLines(repo, platforms)] : []),
        "",
        ...integrationLines(file, publicKey),
      ],
      { dryRun: true, ...summary, public: isPublic },
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
  // One tag rule per prefix; existing rules stay.
  for (const name of tagPolicies) {
    if (!policies.branch_policies?.some((item) => item.name === name && (item.type ?? "branch") === "tag")) {
      await deps.gh.run(["api", "-X", "POST", `repos/${repo}/environments/${ENVIRONMENT}/deployment-branch-policies`, "--input", "-"], {
        input: JSON.stringify({ name, type: "tag" }),
      });
    }
  }

  if (isPublic) {
    await deps.gh.run(["api", "-X", "PUT", `repos/${repo}/actions/permissions/fork-pr-contributor-approval`, "--input", "-"], {
      input: JSON.stringify({ approval_policy: "all_external_contributors" }),
    });
  }

  const previous = (await api.listTokens(file.app)).filter((token) => token.label === label);
  const created = await api.createToken(file.app, label);
  const values: Record<string, string> = {
    ...(signing
      ? {
        APPLE_CERTIFICATE_BASE64: (await readFile(signing.certificate)).toString("base64"),
        APPLE_CERTIFICATE_PASSWORD: (await readFile(signing.password, "utf8")).replace(/[\r\n]+/g, ""),
        APPLE_API_KEY_BASE64: (await readFile(signing.apiKey)).toString("base64"),
        APPLE_KEY_ID: signing.keyId,
        APPLE_ISSUER_ID: issuer!,
      }
      : {}),
    ...(azure ? azure.secrets : {}),
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
    await writeFile(workflowPath, workflowTemplate(file.tagPrefix, platforms, form, file.updater), { flag: "wx" });
  }

  out.result(
    [
      `${repo} is ready to release ${file.app} to ${file.remote.name}.`,
      `  Environment: ${ENVIRONMENT} (tags ${policy}), ${secretNames.length} secrets set`,
      writeWorkflow ? `  Wrote ${WORKFLOW_PATH}. Commit it.` : `  Kept the existing ${WORKFLOW_PATH}.`,
      `  Release by pushing a tag on main, e.g. ${prefixes.map((prefix) => `${prefix}1.0.0`).join(" or ")}`,
      previous.length ? `  Revoked ${previous.length} older publish token${previous.length === 1 ? "" : "s"}.` : "",
      isPublic ? `  Fork pull requests now need your approval before their workflows run.` : "",
      "",
      ...(isPublic ? [...publicRepoLines(repo, platforms), ""] : []),
      ...integrationLines(file, publicKey),
    ].filter((line, index, lines) => line !== "" || lines[index - 1] !== ""),
    { dryRun: false, ...summary, tokenId: created.id, revokedTokens: previous.map((token) => token.id) },
  );
}

function publicRepoLines(repo: string, platforms: Platform[]): string[] {
  const lines = [`${repo} is public. The release runners only take jobs from private repos and allowlisted public ones.`];
  if (platforms.includes("mac")) {
    lines.push(
      `  macOS: add ${repo} to the publicRepositories list of the "personal" source in ralph's`,
      `  controller config (see Proletic/macos-runner).`,
    );
  }
  if (platforms.includes("windows")) {
    lines.push(`  Windows: add ${repo} to the Windows runner controller's public-repo allowlist.`);
  }
  lines.push(`Until then the release jobs stay queued.`);
  return lines;
}
