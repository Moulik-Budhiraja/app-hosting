import { usage } from "./errors.js";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type Version = [number, number, number];

export function parseVersion(value: string): Version {
  const match = VERSION.exec(value.trim());
  if (!match) throw usage(`"${value}" isn't a version. Versions look like 1.2.3.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersion(value: string): boolean {
  return VERSION.test(value);
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** The default build number: 1.2.3 is 100200300, the scheme hobola uses. */
export function defaultBuild(value: string): number {
  const [major, minor, patch] = parseVersion(value);
  if (minor >= 1000 || patch >= 1000) {
    throw usage(`The default build number needs minor and patch below 1000 (${value}). Pass --build.`);
  }
  const build = major * 100_000_000 + minor * 100_000 + patch * 100;
  if (!Number.isSafeInteger(build)) throw usage(`${value} is too large for a build number. Pass --build.`);
  return build;
}

export function parseBuild(value: string): number {
  if (!/^[1-9]\d*$/.test(value.trim())) throw usage(`"${value}" isn't a build number. Builds are positive integers.`);
  const build = Number(value);
  if (!Number.isSafeInteger(build)) throw usage(`Build ${value} is too large.`);
  return build;
}
