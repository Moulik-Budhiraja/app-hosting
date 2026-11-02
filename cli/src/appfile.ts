import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkRemoteName, normalizeUrl } from "./config.js";
import { CliError, EXIT } from "./errors.js";

export const APP_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const RESERVED_APP_NAMES = new Set(["api", "healthz", "assets", "download"]);

export type Updater = "sparkle" | "electron";
export type Platform = "mac" | "windows";
export const PLATFORMS: readonly Platform[] = ["mac", "windows"];
export const PLATFORM_NAMES: Record<Platform, string> = { mac: "macOS", windows: "Windows" };

/** Minimum system versions, as the server checks them: 13.0 on macOS, 10.0 or 10.0.17763 on Windows. */
export const MINIMUM_SYSTEM: Record<Platform, RegExp> = {
  mac: /^\d{1,2}(\.\d{1,2}){0,2}$/,
  windows: /^\d{1,2}(\.\d{1,5}){0,2}$/,
};

export interface NativeBuild {
  kind: "native";
  command: string;
  app: string;
  entitlements: string | null;
  dmgName: string;
}

export interface ElectronBuild {
  kind: "electron";
  command: string;
  dmg: string;
  zip: string;
  blockmap?: string;
}

export type MacBuild = NativeBuild | ElectronBuild;

export interface WindowsNativeBuild {
  kind: "native";
  command: string;
  installer: string;
  minimumSystemVersion?: string;
  icon?: string;
}

export interface WindowsElectronBuild {
  kind: "electron";
  command: string;
  installer: string;
  blockmap?: string;
  minimumSystemVersion?: string;
  icon?: string;
}

export type WindowsBuild = WindowsNativeBuild | WindowsElectronBuild;

export interface Builds {
  mac?: MacBuild;
  windows?: WindowsBuild;
}

export interface AppFile {
  app: string;
  remote: { name: string; url: string };
  updater: Updater;
  tagPrefix: string;
  builds: Builds;
}

export const APP_FILE = "apps.json";

export function isPlatform(value: unknown): value is Platform {
  return value === "mac" || value === "windows";
}

/** The platforms apps.json builds, in a fixed order. */
export function platformsOf(file: Pick<AppFile, "builds">): Platform[] {
  return PLATFORMS.filter((platform) => file.builds[platform] !== undefined);
}

/** The feed each updater reads on each platform, relative to /<app>/. */
export function feedName(updater: Updater, platform: Platform): string {
  if (updater === "sparkle") return platform === "mac" ? "appcast.xml" : "appcast-windows.xml";
  return platform === "mac" ? "latest-mac.yml" : "latest.yml";
}

export function checkAppName(name: string): string {
  if (!APP_NAME.test(name)) {
    throw new CliError(
      `"${name}" isn't a valid app name. Use 2–40 lowercase letters, digits and dashes, starting with a letter or digit.`,
      EXIT.usage,
      "BAD_APP_NAME",
    );
  }
  if (RESERVED_APP_NAMES.has(name)) {
    throw new CliError(`"${name}" is reserved. Pick another app name.`, EXIT.usage, "BAD_APP_NAME");
  }
  return name;
}

function bad(message: string): CliError {
  return new CliError(`apps.json: ${message}`, EXIT.usage, "BAD_APPS_JSON");
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw bad(`${field} must be a non-empty string.`);
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, field);
}

/** A path the release scripts may use: inside the repo, so no leading / or ~ and no "..". */
function repoPath(value: unknown, field: string): string {
  const path = text(value, field);
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) {
    throw bad(`${field} must be a path inside the repo.`);
  }
  return path;
}

function optionalRepoPath(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return repoPath(value, field);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!;
}

function parseMacBuild(build: Record<string, unknown>, updater: Updater, field: string): MacBuild {
  if (build.kind === "native") {
    if (updater !== "sparkle") throw bad(`a "native" build needs updater "sparkle".`);
    const appPath = repoPath(build.app, `${field}.app`);
    if (!appPath.endsWith(".app")) throw bad(`${field}.app must be the path of a .app bundle.`);
    const entitlements = build.entitlements === undefined ? null : build.entitlements;
    if (entitlements !== null && (typeof entitlements !== "string" || !entitlements.trim())) {
      throw bad(`${field}.entitlements must be a path or null.`);
    }
    if (entitlements !== null) repoPath(entitlements, `${field}.entitlements`);
    const fallbackName = baseName(appPath).replace(/\.app$/, "").replace(/\s+/g, "");
    const dmgName = optionalText(build.dmgName, `${field}.dmgName`) ?? fallbackName;
    if (!/^[A-Za-z0-9._-]+$/.test(dmgName)) throw bad(`${field}.dmgName may only contain letters, digits, dots, dashes and underscores.`);
    return {
      kind: "native",
      command: text(build.command, `${field}.command`),
      app: appPath,
      entitlements: entitlements as string | null,
      dmgName,
    };
  }
  if (build.kind === "electron") {
    if (updater !== "electron") throw bad(`an "electron" build needs updater "electron".`);
    const blockmap = optionalRepoPath(build.blockmap, `${field}.blockmap`);
    return {
      kind: "electron",
      command: text(build.command, `${field}.command`),
      dmg: repoPath(build.dmg, `${field}.dmg`),
      zip: repoPath(build.zip, `${field}.zip`),
      ...(blockmap ? { blockmap } : {}),
    };
  }
  throw bad(`${field}.kind must be "native" or "electron".`);
}

function parseWindowsBuild(build: Record<string, unknown>, updater: Updater, field: string): WindowsBuild {
  if (build.kind !== "native" && build.kind !== "electron") throw bad(`${field}.kind must be "native" or "electron".`);
  if (build.kind === "native" && updater !== "sparkle") throw bad(`a "native" build needs updater "sparkle".`);
  if (build.kind === "electron" && updater !== "electron") throw bad(`an "electron" build needs updater "electron".`);
  const command = text(build.command, `${field}.command`);
  const installer = repoPath(build.installer, `${field}.installer`);
  if (build.kind === "electron" ? !installer.endsWith(".exe") : !/\.(exe|msi)$/.test(installer)) {
    throw bad(`${field}.installer must end in ${build.kind === "electron" ? ".exe (an NSIS installer)" : ".exe or .msi"}.`);
  }
  const minimumSystemVersion = optionalText(build.minimumSystemVersion, `${field}.minimumSystemVersion`);
  if (minimumSystemVersion !== undefined && !MINIMUM_SYSTEM.windows.test(minimumSystemVersion)) {
    throw bad(`${field}.minimumSystemVersion must look like 10.0 or 10.0.17763.`);
  }
  const icon = optionalRepoPath(build.icon, `${field}.icon`);
  const extras = { ...(minimumSystemVersion ? { minimumSystemVersion } : {}), ...(icon ? { icon } : {}) };
  if (build.kind === "native") {
    if (build.blockmap !== undefined && build.blockmap !== null) throw bad(`${field}.blockmap is only for electron builds.`);
    return { kind: "native", command, installer, ...extras };
  }
  const blockmap = optionalRepoPath(build.blockmap, `${field}.blockmap`);
  if (blockmap && baseName(blockmap) !== `${baseName(installer)}.blockmap`) {
    throw bad(`${field}.blockmap must be named ${baseName(installer)}.blockmap, after the installer.`);
  }
  return { kind: "electron", command, installer, ...(blockmap ? { blockmap } : {}), ...extras };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateAppFile(raw: unknown): AppFile {
  if (!isObject(raw)) throw bad("must be a JSON object.");
  const value = raw;
  const app = text(value.app, "app");
  try {
    checkAppName(app);
  } catch (error) {
    throw bad((error as Error).message);
  }

  const remote = value.remote as Record<string, unknown> | undefined;
  if (!remote || typeof remote !== "object") throw bad('remote must be {"name": ..., "url": ...}.');
  const remoteName = text(remote.name, "remote.name");
  const remoteUrl = text(remote.url, "remote.url");
  try {
    checkRemoteName(remoteName);
  } catch (error) {
    throw bad((error as Error).message);
  }
  let url: string;
  try {
    url = normalizeUrl(remoteUrl, "remote.url");
  } catch (error) {
    throw bad((error as Error).message);
  }

  if (value.updater !== "sparkle" && value.updater !== "electron") throw bad('updater must be "sparkle" or "electron".');
  const updater = value.updater;

  const tagPrefix = value.tagPrefix === undefined ? "v" : text(value.tagPrefix, "tagPrefix");
  if (/[\s*?[\]~^:\\]/.test(tagPrefix)) throw bad("tagPrefix can't contain spaces or wildcard characters.");

  // The older form, a top-level "build", is the macOS build.
  const builds: Builds = {};
  if (value.build !== undefined && value.builds !== undefined) {
    throw bad('use "builds" only; "build" is the older name for "builds.mac".');
  }
  if (value.build !== undefined) {
    if (!isObject(value.build)) throw bad("build must be an object.");
    builds.mac = parseMacBuild(value.build, updater, "build");
  } else {
    if (!isObject(value.builds)) throw bad('builds is required, with a "mac" or "windows" build.');
    for (const key of Object.keys(value.builds)) {
      if (!isPlatform(key)) throw bad(`builds.${key} isn't a platform. Use "mac" or "windows".`);
    }
    const { mac, windows } = value.builds;
    if (mac !== undefined && mac !== null) {
      if (!isObject(mac)) throw bad("builds.mac must be an object.");
      builds.mac = parseMacBuild(mac, updater, "builds.mac");
    }
    if (windows !== undefined && windows !== null) {
      if (!isObject(windows)) throw bad("builds.windows must be an object.");
      builds.windows = parseWindowsBuild(windows, updater, "builds.windows");
    }
    if (!builds.mac && !builds.windows) throw bad('builds needs a "mac" or "windows" build.');
  }

  return { app, remote: { name: remoteName, url }, updater, tagPrefix, builds };
}

export async function readAppFile(dir: string): Promise<AppFile> {
  const path = join(dir, APP_FILE);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(
        `No apps.json in ${dir}. Run this in an app repo, pass -C <dir>, or create one with: apps create <app> --remote <remote> --updater sparkle|electron`,
        EXIT.usage,
        "NO_APPS_JSON",
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw bad("isn't valid JSON.");
  }
  return validateAppFile(parsed);
}

export async function appFileExists(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, APP_FILE));
    return true;
  } catch {
    return false;
  }
}

export async function writeAppFile(dir: string, file: AppFile): Promise<string> {
  const path = join(dir, APP_FILE);
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" });
  return path;
}

/** Fills {version} in artifact paths. */
export function expandPath(template: string, version: string): string {
  return template.replaceAll("{version}", version);
}

export function titleFromName(name: string): string {
  return name.split("-").filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

export function defaultBuildSection(name: string, title: string, kind: "native" | "electron", platform: "mac"): MacBuild;
export function defaultBuildSection(name: string, title: string, kind: "native" | "electron", platform: "windows"): WindowsBuild;
export function defaultBuildSection(name: string, title: string, kind: "native" | "electron"): MacBuild;
export function defaultBuildSection(name: string, title: string, kind: "native" | "electron", platform?: Platform): MacBuild | WindowsBuild;
export function defaultBuildSection(name: string, title: string, kind: "native" | "electron", platform: Platform = "mac"): MacBuild | WindowsBuild {
  const compact = title.replace(/[^A-Za-z0-9]+/g, "") || name;
  const dashed = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || name;
  if (platform === "windows") {
    if (kind === "native") return { kind, command: "./scripts/build.ps1", installer: `build/${compact}-Setup-{version}.exe` };
    return {
      kind,
      command: "npm run build:win",
      installer: `dist/${dashed}-Setup-{version}.exe`,
      blockmap: `dist/${dashed}-Setup-{version}.exe.blockmap`,
    };
  }
  if (kind === "native") {
    return { kind, command: "./scripts/build.sh", app: `build/${title}.app`, entitlements: null, dmgName: compact };
  }
  return {
    kind,
    command: "npm run build:mac",
    dmg: `dist/${dashed}-{version}.dmg`,
    zip: `dist/${dashed}-{version}-mac.zip`,
    blockmap: `dist/${dashed}-{version}-mac.zip.blockmap`,
  };
}
