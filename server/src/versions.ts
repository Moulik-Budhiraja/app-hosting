const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function parseVersion(version: string): [number, number, number] | null {
  const match = VERSION_RE.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersion(version: unknown): version is string {
  return typeof version === 'string' && parseVersion(version) !== null;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`Not a version: ${left ? b : a}`);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}

/** 1.2.3 is 100200300, the same scheme hobola's releases use. */
export function defaultBuild(version: string): number {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`Not a version: ${version}`);
  const [major, minor, patch] = parts;
  return major * 100_000_000 + minor * 100_000 + patch * 100;
}
