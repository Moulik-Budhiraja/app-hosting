import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkRemoteName, normalizeUrl } from "./config.js";
import { CliError, EXIT } from "./errors.js";

export const APP_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const RESERVED_APP_NAMES = new Set(["api", "healthz", "assets", "download"]);

export type Updater = "sparkle" | "electron";

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

export interface AppFile {
  app: string;
  remote: { name: string; url: string };
  updater: Updater;
  tagPrefix: string;
  build: NativeBuild | ElectronBuild;
}

export const APP_FILE = "apps.json";

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

export function validateAppFile(raw: unknown): AppFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("must be a JSON object.");
  const value = raw as Record<string, unknown>;
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

  const build = value.build as Record<string, unknown> | undefined;
  if (!build || typeof build !== "object") throw bad("build is required.");
  let parsedBuild: NativeBuild | ElectronBuild;
  if (build.kind === "native") {
    if (updater !== "sparkle") throw bad('a "native" build needs updater "sparkle".');
    const appPath = text(build.app, "build.app");
    if (!appPath.endsWith(".app")) throw bad("build.app must be the path of a .app bundle.");
    const entitlements = build.entitlements === undefined ? null : build.entitlements;
    if (entitlements !== null && (typeof entitlements !== "string" || !entitlements.trim())) {
      throw bad("build.entitlements must be a path or null.");
    }
    const fallbackName = appPath.split("/").pop()!.replace(/\.app$/, "").replace(/\s+/g, "");
    const dmgName = optionalText(build.dmgName, "build.dmgName") ?? fallbackName;
    if (!/^[A-Za-z0-9._-]+$/.test(dmgName)) throw bad("build.dmgName may only contain letters, digits, dots, dashes and underscores.");
    parsedBuild = {
      kind: "native",
      command: text(build.command, "build.command"),
      app: appPath,
      entitlements: entitlements as string | null,
      dmgName,
    };
  } else if (build.kind === "electron") {
    if (updater !== "electron") throw bad('an "electron" build needs updater "electron".');
    const blockmap = optionalText(build.blockmap, "build.blockmap");
    parsedBuild = {
      kind: "electron",
      command: text(build.command, "build.command"),
      dmg: text(build.dmg, "build.dmg"),
      zip: text(build.zip, "build.zip"),
      ...(blockmap ? { blockmap } : {}),
    };
  } else {
    throw bad('build.kind must be "native" or "electron".');
  }

  return { app, remote: { name: remoteName, url }, updater, tagPrefix, build: parsedBuild };
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

/** Fills {version} in electron artifact paths. */
export function expandPath(template: string, version: string): string {
  return template.replaceAll("{version}", version);
}

export function titleFromName(name: string): string {
  return name.split("-").filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

export function defaultBuildSection(name: string, title: string, kind: "native" | "electron"): NativeBuild | ElectronBuild {
  const compact = title.replace(/[^A-Za-z0-9]+/g, "") || name;
  if (kind === "native") {
    return { kind, command: "./scripts/build.sh", app: `build/${title}.app`, entitlements: null, dmgName: compact };
  }
  const dashed = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || name;
  return {
    kind,
    command: "npm run build:mac",
    dmg: `dist/${dashed}-{version}.dmg`,
    zip: `dist/${dashed}-{version}-mac.zip`,
    blockmap: `dist/${dashed}-{version}-mac.zip.blockmap`,
  };
}
