import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PLATFORM_NAMES, hasPlatform } from './feeds.ts';
import { HttpError, badRequest, isObject } from './http.ts';
import { isSparkleSignature, verifySparkleSignature } from './sparkle.ts';
import type { AppRecord, Platform, Release, ReleaseFile, Role, Store, Updater } from './store.ts';
import { isPlatform, writeJsonAtomic } from './store.ts';
import { compareVersions, defaultBuild, isVersion } from './versions.ts';

export const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_FILE_SIZE = 4 * 1024 ** 3;
const FILE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const MIN_SYSTEM_RE: Record<Platform, RegExp> = {
  mac: /^\d{1,2}(\.\d{1,2}){0,2}$/,
  windows: /^\d{1,2}(\.\d{1,5}){0,2}$/,
};
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_NOTES = 100_000;

interface DeclaredFile {
  name: string;
  role: Role;
  size: number;
  sha256: string;
}

interface UploadState {
  id: string;
  app: string;
  /** Missing in uploads started before Windows support, which were all macOS. */
  platform?: Platform;
  version: string;
  build: number;
  notes: string;
  minimumSystemVersion?: string;
  edSignature?: string;
  files: DeclaredFile[];
  createdAt: string;
  expiresAt: string;
  committed: boolean;
}

/** The roles a platform's files take, with how many of each: [min, max]. */
const FILE_RULES: Record<Updater, Record<Platform, Partial<Record<Role, [number, number]>>>> = {
  sparkle: { mac: { dmg: [1, 1] }, windows: { installer: [1, 1] } },
  electron: { mac: { dmg: [1, 1], zip: [1, 1], blockmap: [0, 1] }, windows: { installer: [1, 1], blockmap: [0, 1] } },
};

const FILES_HINT: Record<Updater, Record<Platform, string>> = {
  sparkle: { mac: 'Sparkle apps upload only the DMG for macOS', windows: 'Sparkle apps upload only the installer (.exe or .msi) for Windows' },
  electron: {
    mac: 'Electron apps upload the DMG and the zip, and optionally its blockmap, for macOS',
    windows: 'Electron apps upload the installer (.exe), and optionally its blockmap, for Windows',
  },
};

const inProgress = new Set<string>();

function uploadDir(store: Store, id: string): string {
  return path.join(store.uploadsDir(), id);
}

function stateFile(store: Store, id: string): string {
  return path.join(uploadDir(store, id), 'upload.json');
}

function isFileName(name: unknown): name is string {
  return typeof name === 'string' && FILE_NAME_RE.test(name) && name !== 'release.json';
}

function parseFiles(app: AppRecord, platform: Platform, value: unknown): DeclaredFile[] {
  const rules = FILE_RULES[app.updater][platform];
  const hint = FILES_HINT[app.updater][platform];
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) throw badRequest('invalid_files', hint);
  const files = value.map((entry): DeclaredFile => {
    if (!isObject(entry)) throw badRequest('invalid_files', 'Each file needs name, role, size and sha256');
    const { name, role, size } = entry;
    const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : '';
    if (!isFileName(name)) throw badRequest('invalid_file_name', 'File names may only use letters, digits, ".", "_" and "-"');
    if (role !== 'dmg' && role !== 'zip' && role !== 'blockmap' && role !== 'installer') throw badRequest('invalid_role', `Unknown role for ${name}`);
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_SIZE) {
      throw badRequest('invalid_size', `${name} must be between 1 byte and 4 GiB`);
    }
    if (!SHA256_RE.test(sha256)) throw badRequest('invalid_sha256', `${name} needs a hex sha256`);
    return { name, role, size, sha256 };
  });

  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw badRequest('invalid_files', 'File names must be unique');
  }
  for (const file of files) {
    if (!rules[file.role]) throw badRequest('invalid_files', `${hint}; ${file.name} can't have role ${file.role}`);
  }
  for (const [role, [min, max]] of Object.entries(rules) as [Role, [number, number]][]) {
    const count = files.filter((file) => file.role === role).length;
    if (count < min || count > max) throw badRequest('invalid_files', hint);
  }
  const installer = files.find((file) => file.role === 'installer');
  if (installer) {
    const extensions = app.updater === 'electron' ? ['.exe'] : ['.exe', '.msi'];
    if (!extensions.some((ext) => installer.name.toLowerCase().endsWith(ext))) {
      throw badRequest('invalid_files', `The installer must be ${extensions.join(' or ')}`);
    }
  }
  const blockmap = files.find((file) => file.role === 'blockmap');
  if (blockmap) {
    const archive = files.find((file) => file.role === (platform === 'mac' ? 'zip' : 'installer'))!;
    if (blockmap.name !== `${archive.name}.blockmap`) {
      throw badRequest('invalid_files', `The blockmap must be named ${archive.name}.blockmap`);
    }
  }
  return files;
}

/**
 * Checks the version rules for publishing `platform` of `version`, and returns
 * the build to use. Either it's a new release, newer than every release, or a
 * new platform for an existing release.
 */
function checkVersion(releases: Release[], platform: Platform, version: string, build: number | undefined, names: string[]): number {
  const label = PLATFORM_NAMES[platform];
  const existing = releases.find((release) => release.version === version);
  if (existing) {
    if (hasPlatform(existing, platform)) {
      throw new HttpError(409, 'already_published', `${version} is already published for ${label}`);
    }
    if (existing.withdrawn) throw new HttpError(409, 'release_withdrawn', `${version} was withdrawn; restore it first or publish a newer version`);
    for (const release of releases) {
      if (release !== existing && hasPlatform(release, platform) && compareVersions(version, release.version) <= 0) {
        throw new HttpError(409, 'version_not_newer', `${version} is not newer than ${label}'s ${release.version}`);
      }
    }
    if (build !== undefined && build !== existing.build) {
      throw new HttpError(409, 'build_mismatch', `${version} already has build ${existing.build}, not ${build}`);
    }
    const clash = names.find((name) => existing.files.some((file) => file.name === name));
    if (clash) throw new HttpError(409, 'file_exists', `${version} already has a file named ${clash}`);
    return existing.build;
  }

  const resolved = build ?? defaultBuild(version);
  for (const release of releases) {
    if (compareVersions(version, release.version) <= 0) {
      throw new HttpError(409, 'version_not_newer', `${version} is not newer than ${release.version}`);
    }
    if (resolved <= release.build) {
      throw new HttpError(409, 'build_not_higher', `Build ${resolved} is not higher than ${release.version}'s build ${release.build}`);
    }
  }
  return resolved;
}

export async function startUpload(store: Store, app: AppRecord, body: unknown): Promise<UploadState> {
  if (!isObject(body)) throw badRequest('invalid_body', 'Send a JSON object');
  const { version, notes, minimumSystemVersion, edSignature } = body;
  const platform = body.platform ?? 'mac';
  if (!isPlatform(platform)) throw badRequest('invalid_platform', 'platform must be mac or windows');
  if (!isVersion(version)) throw badRequest('invalid_version', 'version must look like 1.2.3');
  const build = body.build;
  if (build !== undefined && (typeof build !== 'number' || !Number.isSafeInteger(build) || build < 1)) {
    throw badRequest('invalid_build', 'build must be a positive integer');
  }
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_NOTES)) {
    throw badRequest('invalid_notes', 'notes must be markdown text under 100,000 characters');
  }
  if (minimumSystemVersion !== undefined && (typeof minimumSystemVersion !== 'string' || !MIN_SYSTEM_RE[platform].test(minimumSystemVersion))) {
    throw badRequest('invalid_minimum_system_version', `minimumSystemVersion must look like ${platform === 'mac' ? '13.0' : '10.0 or 10.0.17763'}`);
  }
  if (app.updater === 'sparkle') {
    const what = platform === 'mac' ? 'the DMG' : 'the installer';
    if (!isSparkleSignature(edSignature)) throw badRequest('invalid_signature', `Sparkle apps need edSignature: base64 Ed25519 signature of ${what}`);
  } else if (edSignature !== undefined) {
    throw badRequest('invalid_signature', 'edSignature is only for Sparkle apps');
  }
  const files = parseFiles(app, platform, body.files);
  const resolvedBuild = checkVersion(await store.listReleases(app.name), platform, version, build as number | undefined, files.map((file) => file.name));

  const now = Date.now();
  const state: UploadState = {
    id: randomBytes(16).toString('hex'),
    app: app.name,
    platform,
    version,
    build: resolvedBuild,
    notes: typeof notes === 'string' ? notes : '',
    ...(typeof minimumSystemVersion === 'string' ? { minimumSystemVersion } : {}),
    ...(typeof edSignature === 'string' ? { edSignature } : {}),
    files,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + UPLOAD_TTL_MS).toISOString(),
    committed: false,
  };
  const dir = uploadDir(store, state.id);
  await fs.mkdir(path.join(dir, 'parts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'files'), { recursive: true });
  await writeJsonAtomic(stateFile(store, state.id), state);
  return state;
}

async function loadUpload(store: Store, app: string, id: string): Promise<UploadState> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(404, 'upload_not_found', 'No such upload');
  let state: UploadState;
  try {
    state = JSON.parse(await fs.readFile(stateFile(store, id), 'utf8')) as UploadState;
  } catch {
    throw new HttpError(404, 'upload_not_found', 'No such upload');
  }
  if (state.app !== app) throw new HttpError(404, 'upload_not_found', 'No such upload');
  if (state.committed) throw new HttpError(409, 'already_published', `${state.version} was already published from this upload`);
  if (Date.parse(state.expiresAt) < Date.now()) throw new HttpError(410, 'upload_expired', 'This upload expired; start a new one');
  return state;
}

/** Streams one declared file to disk, checking its size and sha256 as it goes. */
export async function receiveFile(store: Store, app: string, id: string, name: string, req: IncomingMessage): Promise<void> {
  const state = await loadUpload(store, app, id);
  const declared = state.files.find((file) => file.name === name);
  if (!declared) throw new HttpError(404, 'file_not_declared', `${name} isn't part of this upload`);
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) !== declared.size) {
    throw badRequest('size_mismatch', `${name} should be ${declared.size} bytes, not ${length}`);
  }
  const key = `${id}/${name}`;
  if (inProgress.has(key)) throw new HttpError(409, 'upload_in_progress', `${name} is already being uploaded`);
  inProgress.add(key);

  const part = path.join(uploadDir(store, id), 'parts', name);
  const hash = createHash('sha256');
  let size = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > declared.size) {
        callback(badRequest('size_mismatch', `${name} is larger than the declared ${declared.size} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(req, check, createWriteStream(part));
    if (size !== declared.size) throw badRequest('size_mismatch', `${name} is ${size} bytes, not the declared ${declared.size}`);
    if (hash.digest('hex') !== declared.sha256) throw badRequest('sha256_mismatch', `${name} doesn't match its declared sha256`);
    await fs.rename(part, path.join(uploadDir(store, id), 'files', name));
  } catch (error) {
    await fs.rm(part, { force: true });
    throw error;
  } finally {
    inProgress.delete(key);
  }
}

async function digestFile(file: string): Promise<{ size: number; sha256: string; sha512: string }> {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

/**
 * Publishes an upload: verifies every file, then moves them into place and
 * writes release.json last. A new platform's files join the existing release.
 */
export async function commitUpload(store: Store, app: AppRecord, id: string): Promise<Release> {
  return store.withLock(app.name, async () => {
    const state = await loadUpload(store, app.name, id);
    const platform = state.platform ?? 'mac';
    const filesDir = path.join(uploadDir(store, id), 'files');

    const files: ReleaseFile[] = [];
    for (const declared of state.files) {
      const source = path.join(filesDir, declared.name);
      try {
        await fs.access(source);
      } catch {
        throw new HttpError(409, 'files_missing', `${declared.name} hasn't been uploaded yet`);
      }
      const digest = await digestFile(source);
      if (digest.size !== declared.size || digest.sha256 !== declared.sha256) {
        throw new HttpError(409, 'files_changed', `${declared.name} no longer matches what was declared`);
      }
      files.push({ ...declared, platform, sha512: digest.sha512 });
    }

    if (app.updater === 'sparkle') {
      const signed = files.find((file) => file.role === (platform === 'mac' ? 'dmg' : 'installer'))!;
      const data = await fs.readFile(path.join(filesDir, signed.name));
      if (!app.sparklePublicKey || !verifySparkleSignature(app.sparklePublicKey, data, state.edSignature ?? '')) {
        throw new HttpError(422, 'bad_signature', `edSignature doesn't verify against ${app.name}'s Sparkle public key`);
      }
      signed.edSignature = state.edSignature;
    }

    // The other platform may have published this version since the upload started.
    const releases = await store.listReleases(app.name);
    checkVersion(releases, platform, state.version, state.build, files.map((file) => file.name));
    const existing = releases.find((release) => release.version === state.version);

    const target = store.releaseDir(app.name, state.version);
    // A leftover from an interrupted commit has no release.json, or isn't listed in it, so it's replaced.
    if (!existing) await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    for (const file of files) {
      await fs.rename(path.join(filesDir, file.name), path.join(target, file.name));
    }
    const now = new Date().toISOString();
    const info = { publishedAt: now, ...(state.minimumSystemVersion ? { minimumSystemVersion: state.minimumSystemVersion } : {}) };
    const release: Release = existing
      ? {
          ...existing,
          notes: existing.notes.trim() ? existing.notes : state.notes,
          platforms: { ...existing.platforms, [platform]: info },
          files: [...existing.files, ...files],
        }
      : {
          version: state.version,
          build: state.build,
          notes: state.notes,
          publishedAt: now,
          withdrawn: false,
          platforms: { [platform]: info },
          files,
        };
    await store.saveRelease(app.name, release);

    // Keep a tombstone until the upload expires, so a repeated commit gets 409 already_published.
    await writeJsonAtomic(stateFile(store, id), { ...state, committed: true });
    await fs.rm(filesDir, { recursive: true, force: true });
    await fs.rm(path.join(uploadDir(store, id), 'parts'), { recursive: true, force: true });
    return release;
  });
}

/** Removes uploads past their expiry, committed or not. */
export async function cleanupUploads(store: Store, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const id of await fs.readdir(store.uploadsDir())) {
    const dir = uploadDir(store, id);
    let expired = true;
    try {
      const state = JSON.parse(await fs.readFile(stateFile(store, id), 'utf8')) as UploadState;
      expired = Date.parse(state.expiresAt) < now;
    } catch {
      // No readable state: an upload that never finished starting. Give it the same grace period.
      const stat = await fs.stat(dir).catch(() => null);
      expired = !stat || stat.mtimeMs + UPLOAD_TTL_MS < now;
    }
    if (expired) {
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
