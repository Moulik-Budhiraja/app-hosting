const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-beta\.([1-9]\d?))?$/;

export type Channel = 'stable' | 'beta';

export function isChannel(value: unknown): value is Channel {
  return value === 'stable' || value === 'beta';
}

/** [major, minor, patch, beta]. A stable version's beta is Infinity, so it sorts after its own betas. */
export function parseVersion(version: string): [number, number, number, number] | null {
  const match = VERSION_RE.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? Number(match[4]) : Infinity];
}

/** X.Y.Z, or X.Y.Z-beta.N with N from 1 to 99. */
export function isVersion(version: unknown): version is string {
  return typeof version === 'string' && parseVersion(version) !== null;
}

/** 1.2.3-beta.4 is a beta release. Every other version is stable. */
export function channelOf(version: string): Channel {
  return version.includes('-beta.') ? 'beta' : 'stable';
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  for (let i = 0; i < 4; i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * 1.2.3 is 100200300, the same scheme hobola's releases use. A beta takes one
 * of the 99 builds below its version's: 1.2.3-beta.4 is 100200204, above 1.2.2
 * and below 1.2.3.
 */
export function defaultBuild(version: string): number {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`Not a version: ${version}`);
  const [major, minor, patch, beta] = parts;
  const build = major * 100_000_000 + minor * 100_000 + patch * 100;
  return beta === Infinity ? build : build - 100 + beta;
}
