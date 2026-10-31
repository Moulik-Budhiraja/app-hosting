import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, badRequest, isObject } from './http.ts';
import { isSparkleSignature, verifySparkleSignature } from './sparkle.ts';
import type { AppRecord, Release, ReleaseFile, Role, Store } from './store.ts';
import { writeJsonAtomic } from './store.ts';
import { compareVersions, defaultBuild, isVersion } from './versions.ts';

export const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_FILE_SIZE = 4 * 1024 ** 3;
const FILE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const MIN_SYSTEM_RE = /^\d{1,2}(\.\d{1,2}){0,2}$/;
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

function parseFiles(app: AppRecord, value: unknown): DeclaredFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw badRequest('invalid_files', 'files must list the DMG, plus the zip (and blockmap) for electron apps');
  }
  const files = value.map((entry): DeclaredFile => {
    if (!isObject(entry)) throw badRequest('invalid_files', 'Each file needs name, role, size and sha256');
    const { name, role, size } = entry;
    const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : '';
    if (!isFileName(name)) throw badRequest('invalid_file_name', 'File names may only use letters, digits, ".", "_" and "-"');
    if (role !== 'dmg' && role !== 'zip' && role !== 'blockmap') throw badRequest('invalid_role', `Unknown role for ${name}`);
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_SIZE) {
      throw badRequest('invalid_size', `${name} must be between 1 byte and 4 GiB`);
    }
    if (!SHA256_RE.test(sha256)) throw badRequest('invalid_sha256', `${name} needs a hex sha256`);
    return { name, role, size, sha256 };
  });

  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw badRequest('invalid_files', 'File names must be unique');
  }
  const count = (role: Role) => files.filter((file) => file.role === role).length;
  if (count('dmg') !== 1) throw badRequest('invalid_files', 'Exactly one file must have role dmg');
  if (app.updater === 'sparkle') {
    if (files.length !== 1) throw badRequest('invalid_files', 'Sparkle apps upload only the DMG');
  } else {
    if (count('zip') !== 1) throw badRequest('invalid_files', 'Electron apps need exactly one zip');
    const blockmap = files.find((file) => file.role === 'blockmap');
    const zip = files.find((file) => file.role === 'zip')!;
    if (blockmap && blockmap.name !== `${zip.name}.blockmap`) {
      throw badRequest('invalid_files', `The blockmap must be named ${zip.name}.blockmap`);
    }
  }
  return files;
}

function checkNewer(releases: Release[], version: string, build: number): void {
  for (const release of releases) {
    if (compareVersions(version, release.version) <= 0) {
      throw new HttpError(409, 'version_not_newer', `${version} is not newer than ${release.version}`);
    }
    if (build <= release.build) {
      throw new HttpError(409, 'build_not_higher', `Build ${build} is not higher than ${release.version}'s build ${release.build}`);
    }
  }
}

export async function startUpload(store: Store, app: AppRecord, body: unknown): Promise<UploadState> {
  if (!isObject(body)) throw badRequest('invalid_body', 'Send a JSON object');
  const { version, notes, minimumSystemVersion, edSignature } = body;
  if (!isVersion(version)) throw badRequest('invalid_version', 'version must look like 1.2.3');
  const build = body.build ?? defaultBuild(version);
  if (typeof build !== 'number' || !Number.isSafeInteger(build) || build < 1) {
    throw badRequest('invalid_build', 'build must be a positive integer');
  }
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > MAX_NOTES)) {
    throw badRequest('invalid_notes', 'notes must be markdown text under 100,000 characters');
  }
  if (minimumSystemVersion !== undefined && (typeof minimumSystemVersion !== 'string' || !MIN_SYSTEM_RE.test(minimumSystemVersion))) {
    throw badRequest('invalid_minimum_system_version', 'minimumSystemVersion must look like 13.0');
  }
  if (app.updater === 'sparkle') {
    if (!isSparkleSignature(edSignature)) throw badRequest('invalid_signature', 'Sparkle apps need edSignature: base64 Ed25519 signature of the DMG');
  } else if (edSignature !== undefined) {
    throw badRequest('invalid_signature', 'edSignature is only for Sparkle apps');
  }
  const files = parseFiles(app, body.files);
  checkNewer(await store.listReleases(app.name), version, build);

  const now = Date.now();
  const state: UploadState = {
    id: randomBytes(16).toString('hex'),
    app: app.name,
    version,
    build,
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

/** Publishes an upload: verifies every file, then moves them into place and writes release.json last. */
export async function commitUpload(store: Store, app: AppRecord, id: string): Promise<Release> {
  return store.withLock(app.name, async () => {
    const state = await loadUpload(store, app.name, id);
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
      files.push({ ...declared, sha512: digest.sha512 });
    }

    if (app.updater === 'sparkle') {
      const dmg = files.find((file) => file.role === 'dmg')!;
      const data = await fs.readFile(path.join(filesDir, dmg.name));
      if (!app.sparklePublicKey || !verifySparkleSignature(app.sparklePublicKey, data, state.edSignature ?? '')) {
        throw new HttpError(422, 'bad_signature', `edSignature doesn't verify against ${app.name}'s Sparkle public key`);
      }
    }

    checkNewer(await store.listReleases(app.name), state.version, state.build);

    const target = store.releaseDir(app.name, state.version);
    await fs.rm(target, { recursive: true, force: true }); // a leftover from an interrupted commit has no release.json
    await fs.mkdir(target, { recursive: true });
    for (const file of files) {
      await fs.rename(path.join(filesDir, file.name), path.join(target, file.name));
    }
    const release: Release = {
      version: state.version,
      build: state.build,
      notes: state.notes,
      publishedAt: new Date().toISOString(),
      ...(state.minimumSystemVersion ? { minimumSystemVersion: state.minimumSystemVersion } : {}),
      withdrawn: false,
      ...(state.edSignature ? { edSignature: state.edSignature } : {}),
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
