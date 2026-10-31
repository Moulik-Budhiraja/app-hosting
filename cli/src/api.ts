import { CliError, EXIT } from "./errors.js";

export interface ReleaseFile {
  name: string;
  role: "dmg" | "zip" | "blockmap";
  size: number;
  sha256?: string;
  sha512?: string;
}

export interface Release {
  version: string;
  build: number;
  notes?: string;
  publishedAt: string;
  minimumSystemVersion?: string;
  withdrawn?: boolean;
  edSignature?: string;
  files: ReleaseFile[];
}

export interface AppInfo {
  name: string;
  title: string;
  updater: "sparkle" | "electron";
  sparklePublicKey?: string;
  createdAt?: string;
  releases?: Release[];
  latest?: Release | null;
}

export interface Whoami {
  remote: string;
  scope: "admin" | "publish";
  app?: string;
}

export interface TokenInfo {
  id: string;
  label: string;
  createdAt: string;
}

export interface UploadStart {
  version: string;
  build?: number;
  notes?: string;
  minimumSystemVersion?: string;
  edSignature?: string;
  files: { name: string; role: ReleaseFile["role"]; size: number; sha256: string }[];
}

export class ApiError extends CliError {
  readonly status: number;
  readonly apiCode: string;

  constructor(message: string, status: number, apiCode: string) {
    const exit = status === 401 || status === 403 ? EXIT.auth : EXIT.failure;
    super(message, exit, apiCode.toUpperCase());
    this.status = status;
    this.apiCode = apiCode;
  }
}

/** Talks to one remote. `remoteName` only shapes error messages. */
export class ApiClient {
  readonly baseUrl: string;
  readonly remoteName: string;
  readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, remoteName: string, token: string | undefined, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.remoteName = remoteName;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async send(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (auth) {
      if (!this.token) {
        throw new CliError(
          `Not logged in to ${this.remoteName}. Run: apps login ${this.remoteName}`,
          EXIT.auth,
          "NOT_LOGGED_IN",
        );
      }
      headers.authorization = `Bearer ${this.token}`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.fetchImpl(this.url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (error as Error).message;
      throw new CliError(`Couldn't reach ${this.remoteName} at ${this.baseUrl} (${detail}).`, EXIT.network, "NETWORK");
    }
  }

  async errorFrom(response: Response): Promise<ApiError> {
    let code = `http_${response.status}`;
    let message = `${this.remoteName} answered ${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Not JSON; keep the status line.
    }
    if (response.status === 401) {
      message = `${message}. Your token for ${this.remoteName} was refused. Run: apps login ${this.remoteName}`;
    } else if (response.status === 403) {
      message = `${message}. This needs a token with more access (the admin token, or a publish token for this app).`;
    }
    return new ApiError(message, response.status, code);
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    if (!response.ok) throw await this.errorFrom(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Unauthenticated GET of a public route. Returns null on 404. */
  async publicText(path: string): Promise<string | null> {
    const response = await this.send("GET", path, undefined, false);
    if (response.status === 404) return null;
    if (!response.ok) throw await this.errorFrom(response);
    return response.text();
  }

  whoami(): Promise<Whoami> {
    return this.json("GET", "/api/whoami");
  }

  listApps(): Promise<AppInfo[]> {
    return this.json("GET", "/api/apps");
  }

  createApp(body: { name: string; title: string; updater: string; sparklePublicKey?: string }): Promise<AppInfo> {
    return this.json("POST", "/api/apps", body);
  }

  getApp(app: string): Promise<AppInfo> {
    return this.json("GET", `/api/apps/${encodeURIComponent(app)}`);
  }

  createToken(app: string, label: string): Promise<{ id: string; token: string }> {
    return this.json("POST", `/api/apps/${encodeURIComponent(app)}/tokens`, { label });
  }

  listTokens(app: string): Promise<TokenInfo[]> {
    return this.json("GET", `/api/apps/${encodeURIComponent(app)}/tokens`);
  }

  revokeToken(app: string, id: string): Promise<void> {
    return this.json("DELETE", `/api/apps/${encodeURIComponent(app)}/tokens/${encodeURIComponent(id)}`);
  }

  setWithdrawn(app: string, version: string, withdrawn: boolean): Promise<Release> {
    const action = withdrawn ? "withdraw" : "restore";
    return this.json("POST", `/api/apps/${encodeURIComponent(app)}/releases/${encodeURIComponent(version)}/${action}`);
  }

  startUpload(app: string, body: UploadStart): Promise<{ uploadId: string; expiresAt: string }> {
    return this.json("POST", `/api/apps/${encodeURIComponent(app)}/uploads`, body);
  }

  uploadPath(app: string, uploadId: string, name: string): string {
    return `/api/apps/${encodeURIComponent(app)}/uploads/${encodeURIComponent(uploadId)}/files/${encodeURIComponent(name)}`;
  }

  commitUpload(app: string, uploadId: string): Promise<Release> {
    return this.json("POST", `/api/apps/${encodeURIComponent(app)}/uploads/${encodeURIComponent(uploadId)}/commit`);
  }
}

/** Releases newest first, from `GET /api/apps/<app>` or the public `releases.json`. */
export function releasesOf(value: unknown): Release[] {
  if (Array.isArray(value)) return value as Release[];
  const releases = (value as { releases?: unknown })?.releases;
  return Array.isArray(releases) ? (releases as Release[]) : [];
}
