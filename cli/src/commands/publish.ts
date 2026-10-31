import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ApiError, type UploadStart } from "../api.js";
import { readAppFile } from "../appfile.js";
import { client, formatBytes, type Deps, type Out } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import { SPARKLE_SERVICE, sparkleAccount } from "../secrets.js";
import { publicKeyFor, signArchive } from "../sparkle.js";
import { digestFile, putFile } from "../upload.js";
import { defaultBuild, parseBuild, parseVersion } from "../version.js";
import { feedUrl } from "./setup.js";

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export interface PublishOptions {
  dir: string;
  version?: string;
  build?: string;
  notesFile?: string;
  dmg?: string;
  zip?: string;
  blockmap?: string;
  minimumSystemVersion?: string;
}

interface LocalFile {
  path: string;
  name: string;
  role: "dmg" | "zip" | "blockmap";
  size: number;
  sha256: string;
}

class Progress {
  private readonly out: NodeJS.WritableStream & { isTTY?: boolean };
  private readonly enabled: boolean;
  private last = 0;

  constructor(out: NodeJS.WritableStream & { isTTY?: boolean }, json: boolean) {
    this.out = out;
    this.enabled = Boolean(out.isTTY) && !json;
  }

  update(name: string, sent: number, size: number): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (sent < size && now - this.last < 100) return;
    this.last = now;
    const percent = size ? Math.floor((sent / size) * 100) : 100;
    this.out.write(`\r\x1b[2K  ${name}  ${String(percent).padStart(3)}%  ${formatBytes(sent)} / ${formatBytes(size)}`);
  }

  done(): void {
    if (this.enabled) this.out.write("\r\x1b[2K");
  }
}

export async function publishCommand(deps: Deps, out: Out, options: PublishOptions): Promise<void> {
  const file = await readAppFile(options.dir);
  if (!options.version) throw usage("Pass --version X.Y.Z.");
  const version = parseVersion(options.version).join(".");
  const build = options.build ? parseBuild(options.build) : defaultBuild(version);
  if (!options.dmg) throw usage("Pass --dmg <path>. Every release needs a DMG.");
  if (file.updater === "sparkle" && (options.zip || options.blockmap)) {
    throw usage("Sparkle apps update from the DMG; --zip and --blockmap are for electron apps.");
  }
  if (file.updater === "electron" && !options.zip) throw usage("Electron apps need --zip <path> (the update archive).");
  if (options.blockmap && !options.zip) throw usage("--blockmap goes with --zip.");

  const notes = options.notesFile ? await readFile(resolve(options.dir, options.notesFile), "utf8") : undefined;

  const inputs: { path: string; role: LocalFile["role"] }[] = [{ path: options.dmg, role: "dmg" }];
  if (options.zip) inputs.push({ path: options.zip, role: "zip" });
  if (options.blockmap) inputs.push({ path: options.blockmap, role: "blockmap" });

  const files: LocalFile[] = [];
  for (const input of inputs) {
    const path = resolve(options.dir, input.path);
    const name = basename(path);
    if (!SAFE_NAME.test(name) || name.startsWith(".")) {
      throw usage(`${name}: file names may only use letters, digits, dots, dashes and underscores, and can't start with a dot.`);
    }
    out.info(`Hashing ${name}…`);
    files.push({ path, name, role: input.role, ...(await digestFile(path)) });
  }
  const zip = files.find((item) => item.role === "zip");
  const blockmap = files.find((item) => item.role === "blockmap");
  if (blockmap && zip && blockmap.name !== `${zip.name}.blockmap`) {
    throw usage(`The blockmap must be named ${zip.name}.blockmap (got ${blockmap.name}).`);
  }
  if (new Set(files.map((item) => item.name)).size !== files.length) throw usage("Each file needs a different name.");

  const api = await client(deps, file.remote.name, file.remote.url);
  if (!api.token) {
    throw new CliError(
      `No token for ${file.remote.name}. In CI set APPS_TOKEN; on this Mac run: apps login ${file.remote.name}`,
      EXIT.auth,
      "NOT_LOGGED_IN",
    );
  }

  let edSignature: string | undefined;
  if (file.updater === "sparkle") {
    const key = deps.env.SPARKLE_PRIVATE_KEY?.trim()
      || await deps.secrets.get(SPARKLE_SERVICE, sparkleAccount(file.remote.name, file.app));
    if (!key) {
      throw new CliError(
        `No Sparkle key for ${file.app}. Set SPARKLE_PRIVATE_KEY, or publish from the Mac that ran apps create.`,
        EXIT.failure,
        "NO_SPARKLE_KEY",
      );
    }
    const app = await api.getApp(file.app);
    if (app.sparklePublicKey && app.sparklePublicKey !== publicKeyFor(key)) {
      throw new CliError(
        `The Sparkle key doesn't match ${file.app}'s public key on ${file.remote.name}. Installed copies would refuse this update.`,
        EXIT.failure,
        "SPARKLE_KEY_MISMATCH",
      );
    }
    // Ed25519 signs the whole archive, so the DMG is read into memory once here.
    edSignature = signArchive(await readFile(files[0]!.path), key);
  }

  const start: UploadStart = {
    version,
    build,
    ...(notes !== undefined ? { notes } : {}),
    ...(options.minimumSystemVersion ? { minimumSystemVersion: options.minimumSystemVersion } : {}),
    ...(edSignature ? { edSignature } : {}),
    files: files.map(({ name, role, size, sha256 }) => ({ name, role, size, sha256 })),
  };
  const upload = await api.startUpload(file.app, start);

  const progress = new Progress(deps.stderr, out.json);
  for (const item of files) {
    const result = await putFile(api.url(api.uploadPath(file.app, upload.uploadId, item.name)), api.token, item.path, item.size,
      (sent) => progress.update(item.name, sent, item.size));
    progress.done();
    if (result.status < 200 || result.status >= 300) {
      let message = `Upload of ${item.name} failed (${result.status})`;
      let code = `http_${result.status}`;
      try {
        const body = JSON.parse(result.body) as { error?: { code?: string; message?: string } };
        if (body.error?.message) message = `Upload of ${item.name} failed: ${body.error.message}`;
        if (body.error?.code) code = body.error.code;
      } catch {
        // Not JSON.
      }
      throw new ApiError(message, result.status, code);
    }
    out.info(`Uploaded ${item.name} (${formatBytes(item.size)})`);
  }

  const release = await api.commitUpload(file.app, upload.uploadId);
  const feed = feedUrl(file);
  out.result(
    [
      `Published ${file.app} ${release.version} (build ${release.build}) to ${file.remote.name}.`,
      `  Feed:     ${feed}`,
      `  Download: ${file.remote.url}/${file.app}/`,
    ],
    { app: file.app, remote: file.remote.name, feed, release },
  );
}
