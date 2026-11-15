import { usage } from "./errors.js";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d?))?$/;

/** [major, minor, patch, beta]. A stable version's beta is Infinity, so it sorts after its own betas. */
export type Version = [number, number, number, number];
export type Channel = "stable" | "beta";

export function isChannel(value: unknown): value is Channel {
  return value === "stable" || value === "beta";
}

export function parseVersion(value: string): Version {
  const match = VERSION.exec(value.trim());
  if (!match) throw usage(`"${value}" isn't a version. Versions look like 1.2.3, or 1.2.3-beta.1 for a beta.`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? Number(match[4]) : Infinity];
}

/** The version as the server takes it: checked and trimmed. */
export function normalizeVersion(value: string): string {
  parseVersion(value);
  return value.trim();
}

export function isVersion(value: string): boolean {
  return VERSION.test(value);
}

/** 1.2.3-beta.4 is a beta release. Every other version is stable. */
export function channelOf(version: string): Channel {
  return version.includes("-beta.") ? "beta" : "stable";
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 4; i += 1) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * The default build number: 1.2.3 is 100200300, the scheme hobola uses. A beta
 * takes one of the 99 builds below its version's: 1.2.3-beta.4 is 100200204.
 */
export function defaultBuild(value: string): number {
  const [major, minor, patch, beta] = parseVersion(value);
  if (minor >= 1000 || patch >= 1000) {
    throw usage(`The default build number needs minor and patch below 1000 (${value}). Pass --build.`);
  }
  const stable = major * 100_000_000 + minor * 100_000 + patch * 100;
  const build = beta === Infinity ? stable : stable - 100 + beta;
  if (!Number.isSafeInteger(build)) throw usage(`${value} is too large for a build number. Pass --build.`);
  if (build < 1) throw usage(`${value} has no default build number. Pass --build.`);
  return build;
}

export function parseBuild(value: string): number {
  if (!/^[1-9]\d*$/.test(value.trim())) throw usage(`"${value}" isn't a build number. Builds are positive integers.`);
  const build = Number(value);
  if (!Number.isSafeInteger(build)) throw usage(`Build ${value} is too large.`);
  return build;
}
