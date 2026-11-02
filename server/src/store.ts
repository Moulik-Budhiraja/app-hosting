import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.ts';
import { compareVersions, isVersion } from './versions.ts';

export type Updater = 'sparkle' | 'electron';
export type Platform = 'mac' | 'windows';
export type Role = 'dmg' | 'zip' | 'blockmap' | 'installer';

export const PLATFORMS: readonly Platform[] = ['mac', 'windows'];

export function isPlatform(value: unknown): value is Platform {
  return value === 'mac' || value === 'windows';
}

export interface AppIcon {
  /** sha256 of icon.png, hex. Also versions the icon's URL. */
  sha256: string;
  size: number;
  updatedAt: string;
}

export interface AppRecord {
  name: string;
  title: string;
  updater: Updater;
  sparklePublicKey?: string;
  icon?: AppIcon;
  createdAt: string;
}

export interface ReleaseFile {
  name: string;
  platform: Platform;
  role: Role;
  size: number;
  sha256: string;
  sha512: string;
  /** Sparkle apps only, on the file the updater downloads. */
  edSignature?: string;
}

export interface PlatformInfo {
  publishedAt: string;
  minimumSystemVersion?: string;
}

export interface Release {
  version: string;
  build: number;
  notes: string;
  /** When the first platform was published. */
  publishedAt: string;
  withdrawn: boolean;
  platforms: Partial<Record<Platform, PlatformInfo>>;
  files: ReleaseFile[];
}

/** release.json as stored. Releases from before Windows support are macOS only and keep a few fields at the top. */
export interface StoredRelease extends Omit<Release, 'platforms' | 'files'> {
  platforms?: Release['platforms'];
  minimumSystemVersion?: string;
  edSignature?: string;
  files: (Omit<ReleaseFile, 'platform'> & { platform?: Platform })[];
}

/** Reads either form of release.json as the current one. */
export function normalizeRelease(stored: StoredRelease): Release {
  const { minimumSystemVersion, edSignature, platforms, files, ...rest } = stored;
  if (platforms) return { ...rest, platforms, files: files.map((file) => ({ ...file, platform: file.platform ?? 'mac' })) };
  return {
    ...rest,
    platforms: { mac: { publishedAt: stored.publishedAt, ...(minimumSystemVersion ? { minimumSystemVersion } : {}) } },
    files: files.map((file) => ({
      ...file,
      platform: 'mac' as const,
      ...(edSignature && file.role === 'dmg' ? { edSignature } : {}),
    })),
  };
}

export interface TokenRecord {
  id: string;
  /** sha256 of the token, hex. */
  hash: string;
  app: string;
  label: string;
  createdAt: string;
}

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const RESERVED_NAMES = new Set(['api', 'healthz', 'assets', 'download']);

export function isAppName(name: unknown): name is string {
  return typeof name === 'string' && APP_NAME_RE.test(name) && !RESERVED_NAMES.has(name);
}

/** Writes JSON to a temporary file, flushes it, then renames it into place. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Everything on disk. All writes to one app go through withLock(app). */
export class Store {
  readonly dataDir: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly appCache = new Map<string, AppRecord | null>();
  private readonly releaseCache = new Map<string, Release[]>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.dataDir, 'apps'), { recursive: true });
    await fs.mkdir(this.uploadsDir(), { recursive: true });
  }

  appDir(app: string): string {
    return path.join(this.dataDir, 'apps', app);
  }

  iconFile(app: string): string {
    return path.join(this.appDir(app), 'icon.png');
  }

  releaseDir(app: string, version: string): string {
    return path.join(this.appDir(app), 'releases', version);
  }

  uploadsDir(): string {
    return path.join(this.dataDir, 'uploads');
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    this.locks.set(key, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  // Apps

  async getApp(name: string): Promise<AppRecord | null> {
    if (!isAppName(name)) return null;
    if (this.appCache.has(name)) return this.appCache.get(name)!;
    const record = await readJsonFile<AppRecord>(path.join(this.appDir(name), 'app.json'));
    this.appCache.set(name, record);
    return record;
  }

  async listApps(): Promise<AppRecord[]> {
    const entries = await fs.readdir(path.join(this.dataDir, 'apps'));
    const apps: AppRecord[] = [];
    for (const entry of entries.sort()) {
      const record = await this.getApp(entry);
      if (record) apps.push(record);
    }
    return apps;
  }

  async createApp(record: AppRecord): Promise<void> {
    const dir = this.appDir(record.name);
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new HttpError(409, 'app_exists', `${record.name} already exists on this remote`);
      }
      throw error;
    }
    await fs.mkdir(path.join(dir, 'releases'));
    await this.saveApp(record);
  }

  async saveApp(record: AppRecord): Promise<void> {
    await writeJsonAtomic(path.join(this.appDir(record.name), 'app.json'), record);
    this.appCache.set(record.name, record);
  }

  // Releases

  /** Committed releases, newest first. A release directory without release.json isn't committed. */
  async listReleases(app: string): Promise<Release[]> {
    const cached = this.releaseCache.get(app);
    if (cached) return cached;
    const dir = path.join(this.appDir(app), 'releases');
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const releases: Release[] = [];
    for (const entry of entries) {
      if (!isVersion(entry)) continue;
      const release = await readJsonFile<StoredRelease>(path.join(dir, entry, 'release.json'));
      if (release) releases.push(normalizeRelease(release));
    }
    releases.sort((a, b) => compareVersions(b.version, a.version));
    this.releaseCache.set(app, releases);
    return releases;
  }

  async getRelease(app: string, version: string): Promise<Release | null> {
    if (!isVersion(version)) return null;
    return (await this.listReleases(app)).find((release) => release.version === version) ?? null;
  }

  async saveRelease(app: string, release: Release): Promise<void> {
    await writeJsonAtomic(path.join(this.releaseDir(app, release.version), 'release.json'), release);
    this.releaseCache.delete(app);
  }

  // Publish tokens

  private tokensFile(): string {
    return path.join(this.dataDir, 'tokens.json');
  }

  async listTokens(): Promise<TokenRecord[]> {
    return (await readJsonFile<TokenRecord[]>(this.tokensFile())) ?? [];
  }

  async saveTokens(tokens: TokenRecord[]): Promise<void> {
    await writeJsonAtomic(this.tokensFile(), tokens);
  }
}
