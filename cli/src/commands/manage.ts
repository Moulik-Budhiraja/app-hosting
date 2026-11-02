import { hasPlatform, platformPublishedAt, releasePlatforms, releasesOf, type ApiClient, type Release } from "../api.js";
import { checkAppName, feedName, isPlatform, PLATFORM_NAMES, platformsOf, readAppFile, type Platform, type Updater } from "../appfile.js";
import { getRemote, loadConfig } from "../config.js";
import { client, formatBytes, formatDate, requireAdmin, table, type Deps, type Out } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import { readIcon } from "../icon.js";
import { defaultBuild, parseVersion } from "../version.js";

interface Target {
  app: string;
  remote: string;
  url: string;
  updater?: Updater;
}

async function target(deps: Deps, options: { dir: string; app?: string; remote?: string }): Promise<Target> {
  if (options.app || options.remote) {
    if (!options.app || !options.remote) throw usage("Pass both --app and --remote, or run inside an app repo.");
    const remote = getRemote(await loadConfig(deps.env), options.remote);
    return { app: checkAppName(options.app), remote: options.remote, url: remote.url };
  }
  const file = await readAppFile(options.dir);
  return { app: file.app, remote: file.remote.name, url: file.remote.url, updater: file.updater };
}

/** Releases newest first: with the API when logged in, else from the public list. */
async function loadReleases(api: ApiClient, app: string): Promise<{ releases: Release[]; updater?: Updater; source: "api" | "public" }> {
  if (api.token) {
    const info = await api.getApp(app);
    return { releases: releasesOf(info), updater: info.updater, source: "api" };
  }
  const text = await api.publicText(`/${encodeURIComponent(app)}/releases.json`);
  if (text === null) throw new CliError(`${app} doesn't exist on ${api.remoteName}.`, EXIT.failure, "NOT_FOUND");
  return { releases: releasesOf(JSON.parse(text)), source: "public" };
}

function sortNewestFirst(releases: Release[]): Release[] {
  return [...releases].sort((a, b) => b.build - a.build);
}

/** The newest live release with files for the platform. */
function latestLive(releases: Release[], platform: Platform): Release | undefined {
  return sortNewestFirst(releases).find((release) => !release.withdrawn && hasPlatform(release, platform));
}

export async function releasesCommand(deps: Deps, out: Out, options: { dir: string; app?: string; remote?: string }): Promise<void> {
  const where = await target(deps, options);
  const api = await client(deps, where.remote, where.url);
  const { releases } = await loadReleases(api, where.app);
  const sorted = sortNewestFirst(releases);
  const human = sorted.length
    ? table([
      ["VERSION", "BUILD", "PUBLISHED", "PLATFORMS", "STATUS"],
      ...sorted.map((release) => [
        release.version,
        String(release.build),
        formatDate(release.publishedAt),
        releasePlatforms(release).join(", "),
        release.withdrawn ? "withdrawn" : "live",
      ]),
    ])
    : [`${where.app} has no releases on ${where.remote} yet.`];
  out.result(human, { app: where.app, remote: where.remote, releases: sorted });
}

export async function withdrawCommand(
  deps: Deps,
  out: Out,
  positionals: string[],
  options: { dir: string; app?: string; remote?: string; withdraw: boolean },
): Promise<void> {
  const verb = options.withdraw ? "withdraw" : "restore";
  if (positionals.length !== 1) throw usage(`Usage: apps ${verb} <version>`);
  const version = parseVersion(positionals[0]!).join(".");
  const where = await target(deps, options);
  const api = await client(deps, where.remote, where.url);
  await requireAdmin(deps, api);
  const release = await api.setWithdrawn(where.app, version, options.withdraw);
  out.result(
    options.withdraw
      ? `Withdrew ${where.app} ${version}. It's out of the feed and the download page; copies that already updated keep it.`
      : `Restored ${where.app} ${version}.`,
    { app: where.app, remote: where.remote, release },
  );
}

export async function tokenCommand(
  deps: Deps,
  out: Out,
  positionals: string[],
  options: { dir: string; app?: string; remote?: string; label?: string },
): Promise<void> {
  const [action, ...rest] = positionals;
  const where = await target(deps, options);
  const api = await client(deps, where.remote, where.url);
  await requireAdmin(deps, api);

  if (action === "create") {
    if (rest.length) throw usage("Usage: apps token create [--label L]");
    const label = options.label?.trim() || "manual";
    const created = await api.createToken(where.app, label);
    out.result(
      [`Publish token for ${where.app} on ${where.remote} (shown only once):`, created.token],
      { app: where.app, remote: where.remote, id: created.id, label, token: created.token },
    );
    return;
  }
  if (action === "list" || action === "ls") {
    const tokens = await api.listTokens(where.app);
    out.result(
      tokens.length ? table([["ID", "LABEL", "CREATED"], ...tokens.map((token) => [token.id, token.label, formatDate(token.createdAt)])]) : [`No publish tokens for ${where.app}.`],
      { app: where.app, remote: where.remote, tokens },
    );
    return;
  }
  if (action === "revoke" || action === "rm") {
    if (rest.length !== 1) throw usage("Usage: apps token revoke <id>");
    await api.revokeToken(where.app, rest[0]!);
    out.result(`Revoked token ${rest[0]}.`, { app: where.app, remote: where.remote, id: rest[0], revoked: true });
    return;
  }
  throw usage("Usage: apps token create|list|revoke");
}

export async function iconCommand(
  deps: Deps,
  out: Out,
  positionals: string[],
  options: { dir: string; app?: string; remote?: string; remove: boolean },
): Promise<void> {
  if (options.remove ? positionals.length !== 0 : positionals.length !== 1) {
    throw usage("Usage: apps icon <icon.png> | apps icon --remove");
  }
  const where = await target(deps, options);
  const api = await client(deps, where.remote, where.url);
  if (options.remove) {
    await requireAdmin(deps, api);
    await api.removeIcon(where.app);
    out.result(`Removed ${where.app}'s icon. Its page shows its initial again.`, { app: where.app, remote: where.remote, icon: null });
    return;
  }
  const png = await readIcon(options.dir, positionals[0]!);
  const app = await api.setIcon(where.app, png);
  out.result(`Set ${where.app}'s icon (${formatBytes(png.length)}). It shows on ${where.url}/${where.app}/`, {
    app: where.app,
    remote: where.remote,
    icon: app.icon ?? null,
    url: app.urls?.icon ?? null,
  });
}

export function feedVersion(updater: Updater, text: string): string | null {
  if (updater === "sparkle") {
    const element = /<sparkle:shortVersionString>\s*([^<\s]+)\s*<\/sparkle:shortVersionString>/.exec(text);
    if (element) return element[1]!;
    const attribute = /sparkle:shortVersionString="([^"]+)"/.exec(text);
    return attribute ? attribute[1]! : null;
  }
  const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text);
  return match ? match[1]! : null;
}

export async function statusCommand(deps: Deps, out: Out, options: { dir: string; expect?: string; platform?: string }): Promise<number> {
  const file = await readAppFile(options.dir);
  const expected = options.expect ? parseVersion(options.expect).join(".") : undefined;
  if (options.platform !== undefined && !isPlatform(options.platform)) {
    throw usage(`--platform must be mac or windows, not "${options.platform}".`);
  }
  const platforms: Platform[] = options.platform ? [options.platform as Platform] : platformsOf(file);
  const api = await client(deps, file.remote.name, file.remote.url);
  const { releases, source } = await loadReleases(api, file.app);

  const lines = [`${file.app} on ${file.remote.name} (${file.remote.url}), ${file.updater}`];
  const results = [];
  for (const platform of platforms) {
    const latest = latestLive(releases, platform);
    const feedPath = `/${file.app}/${feedName(file.updater, platform)}`;
    const feedText = await api.publicText(feedPath);
    const live = feedText === null ? null : feedVersion(file.updater, feedText);
    const want = expected ?? latest?.version ?? null;
    const ok = want === null ? live === null : live === want;
    lines.push(
      `  ${PLATFORM_NAMES[platform]}`,
      `    Latest release: ${latest ? `${latest.version} (build ${latest.build}, ${formatDate(platformPublishedAt(latest, platform))})` : "none"}`,
      `    Live feed:      ${live ?? (feedText === null ? "not found" : "no release")}  ${api.url(feedPath)}`,
    );
    if (expected) lines.push(`    Expected:       ${expected}`);
    lines.push(ok ? "    ✓ The feed is up to date." : `    ✗ The feed should report ${want ?? "nothing"} but reports ${live ?? "nothing"}.`);
    results.push({ platform, latest: latest ?? null, feed: { url: api.url(feedPath), version: live }, ok });
  }
  const ok = results.every((result) => result.ok);
  out.result(lines, {
    app: file.app,
    remote: file.remote.name,
    updater: file.updater,
    platforms: results,
    expected: expected ?? null,
    ok,
    source,
  });
  return ok ? EXIT.ok : EXIT.failure;
}

export function buildNumberCommand(out: Out, positionals: string[]): void {
  if (positionals.length !== 1) throw usage("Usage: apps build-number <version>");
  const version = parseVersion(positionals[0]!).join(".");
  const build = defaultBuild(version);
  out.result(String(build), { version, build });
}
