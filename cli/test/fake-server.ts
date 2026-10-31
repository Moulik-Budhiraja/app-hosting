// A small in-memory stand-in for the apps server, following DESIGN.md's API.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

interface StoredFile { name: string; role: string; size: number; sha256: string; sha512?: string; data?: Buffer }
interface StoredRelease {
  version: string; build: number; notes?: string; publishedAt: string; minimumSystemVersion?: string;
  withdrawn: boolean; edSignature?: string; files: StoredFile[];
}
interface StoredApp { name: string; title: string; updater: "sparkle" | "electron"; sparklePublicKey?: string; icon?: { sha256: string; size: number; updatedAt: string }; iconData?: Buffer; createdAt: string; releases: StoredRelease[] }
interface Upload { id: string; app: string; start: Record<string, unknown>; files: Map<string, Buffer>; committed: boolean }

export interface FakeServer {
  url: string;
  adminToken: string;
  apps: Map<string, StoredApp>;
  tokens: { id: string; token: string; app: string; label: string; createdAt: string }[];
  requests: string[];
  close(): Promise<void>;
}

function newer(a: string, b: string): boolean {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return false;
}

export async function startFakeServer(): Promise<FakeServer> {
  const adminToken = `admin-${randomBytes(16).toString("hex")}`;
  const apps = new Map<string, StoredApp>();
  const tokens: FakeServer["tokens"] = [];
  const uploads = new Map<string, Upload>();
  const requests: string[] = [];

  const send = (res: ServerResponse, status: number, body?: unknown, type = "application/json") => {
    res.statusCode = status;
    if (body === undefined) return res.end();
    res.setHeader("content-type", type);
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const scope = (req: IncomingMessage): { scope: "admin" } | { scope: "publish"; app: string } | null => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token === adminToken) return { scope: "admin" };
    const found = tokens.find((item) => item.token === token);
    return found ? { scope: "publish", app: found.app } : null;
  };
  const publicRelease = (release: StoredRelease) => ({
    ...release,
    files: release.files.map(({ data: _data, ...file }) => file),
  });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    requests.push(`${req.method} ${url.pathname}`);

    if (parts[0] !== "api") {
      const app = apps.get(parts[0] ?? "");
      if (!app) return fail(res, 404, "not_found", "Not found");
      const live = [...app.releases].filter((release) => !release.withdrawn).sort((a, b) => b.build - a.build);
      if (parts[1] === "releases.json") return send(res, 200, app.releases.map(publicRelease));
      if (parts[1] === "appcast.xml" && app.updater === "sparkle") {
        const items = live.map((release) => `<item><title>${release.version}</title><sparkle:version>${release.build}</sparkle:version><sparkle:shortVersionString>${release.version}</sparkle:shortVersionString></item>`).join("");
        return send(res, 200, `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`, "application/xml");
      }
      if (parts[1] === "latest-mac.yml" && app.updater === "electron") {
        if (!live[0]) return fail(res, 404, "not_found", "No releases");
        return send(res, 200, `version: ${live[0].version}\npath: x\n`, "text/yaml");
      }
      return fail(res, 404, "not_found", "Not found");
    }

    const who = scope(req);
    if (!who) return fail(res, 401, "unauthorized", "Missing or invalid token");
    const isAdmin = who.scope === "admin";
    const canUse = (app: string) => isAdmin || (who.scope === "publish" && who.app === app);

    if (parts[1] === "whoami" && req.method === "GET") {
      return send(res, 200, who.scope === "admin" ? { remote: "fake", scope: "admin" } : { remote: "fake", scope: "publish", app: who.app });
    }
    if (parts[1] !== "apps") return fail(res, 404, "not_found", "Not found");

    if (parts.length === 2) {
      if (!isAdmin) return fail(res, 403, "forbidden", "Admin only");
      if (req.method === "GET") return send(res, 200, [...apps.values()].map(({ releases: _r, ...app }) => app));
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        if (apps.has(body.name)) return fail(res, 409, "app_exists", `${body.name} already exists`);
        if (body.updater === "sparkle" && !body.sparklePublicKey) return fail(res, 422, "invalid", "sparklePublicKey required");
        const app: StoredApp = { name: body.name, title: body.title, updater: body.updater, sparklePublicKey: body.sparklePublicKey, createdAt: new Date().toISOString(), releases: [] };
        apps.set(app.name, app);
        const { releases: _r, ...summary } = app;
        return send(res, 201, summary);
      }
    }

    const app = apps.get(parts[2] ?? "");
    if (!app) return fail(res, 404, "not_found", "No such app");
    if (!canUse(app.name)) return fail(res, 403, "forbidden", "Token can't use this app");

    if (parts.length === 3 && req.method === "GET") {
      const { iconData: _d, ...info } = app;
      return send(res, 200, { ...info, releases: [...app.releases].sort((a, b) => b.build - a.build).map(publicRelease) });
    }
    if (parts[3] === "icon" && parts.length === 4) {
      const view = () => {
        const { releases: _r, iconData: _d, ...summary } = app;
        return { ...summary, urls: app.icon ? { icon: `${url.origin}/${app.name}/icon.png?v=${app.icon.sha256.slice(0, 12)}` } : {} };
      };
      if (req.method === "PUT") {
        const data = await readBody(req);
        if (req.headers["content-type"] !== "image/png" || data.subarray(1, 4).toString("latin1") !== "PNG") {
          return fail(res, 400, "invalid_icon", "The icon must be a PNG file");
        }
        app.iconData = data;
        app.icon = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length, updatedAt: new Date().toISOString() };
        return send(res, 200, view());
      }
      if (req.method === "DELETE") {
        if (!isAdmin) return fail(res, 403, "forbidden", "Admin only");
        delete app.icon;
        delete app.iconData;
        return send(res, 200, view());
      }
    }
    if (parts[3] === "tokens") {
      if (!isAdmin) return fail(res, 403, "forbidden", "Admin only");
      if (parts.length === 4 && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const item = { id: randomBytes(4).toString("hex"), token: `pub-${randomBytes(16).toString("hex")}`, app: app.name, label: body.label, createdAt: new Date().toISOString() };
        tokens.push(item);
        return send(res, 201, { id: item.id, token: item.token });
      }
      if (parts.length === 4 && req.method === "GET") {
        return send(res, 200, tokens.filter((item) => item.app === app.name).map(({ id, label, createdAt }) => ({ id, label, createdAt })));
      }
      if (parts.length === 5 && req.method === "DELETE") {
        const index = tokens.findIndex((item) => item.id === parts[4] && item.app === app.name);
        if (index < 0) return fail(res, 404, "not_found", "No such token");
        tokens.splice(index, 1);
        return send(res, 204);
      }
    }
    if (parts[3] === "releases" && parts.length === 6 && req.method === "POST") {
      if (!isAdmin) return fail(res, 403, "forbidden", "Admin only");
      const release = app.releases.find((item) => item.version === parts[4]);
      if (!release) return fail(res, 404, "not_found", "No such release");
      release.withdrawn = parts[5] === "withdraw";
      return send(res, 200, publicRelease(release));
    }
    if (parts[3] === "uploads") {
      if (parts.length === 4 && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        if (app.releases.some((release) => !newer(body.version, release.version))) {
          return fail(res, 409, "not_newer", `${body.version} isn't newer than every release`);
        }
        const id = randomBytes(6).toString("hex");
        uploads.set(id, { id, app: app.name, start: body, files: new Map(), committed: false });
        return send(res, 201, { uploadId: id, expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString() });
      }
      const upload = uploads.get(parts[4] ?? "");
      if (!upload || upload.app !== app.name) return fail(res, 404, "not_found", "No such upload");
      const declared = upload.start.files as { name: string; role: string; size: number; sha256: string }[];
      if (parts[5] === "files" && parts.length === 7 && req.method === "PUT") {
        const spec = declared.find((item) => item.name === parts[6]);
        if (!spec) return fail(res, 404, "not_found", "Undeclared file");
        if (req.headers["content-length"] !== String(spec.size)) return fail(res, 400, "bad_length", "Content-Length mismatch");
        const data = await readBody(req);
        if (data.length !== spec.size) return fail(res, 422, "size_mismatch", "Size mismatch");
        if (createHash("sha256").update(data).digest("hex") !== spec.sha256) return fail(res, 422, "sha256_mismatch", "sha256 mismatch");
        upload.files.set(spec.name, data);
        return send(res, 204);
      }
      if (parts[5] === "commit" && parts.length === 6 && req.method === "POST") {
        if (upload.committed) return fail(res, 409, "already_published", "Already published");
        for (const spec of declared) if (!upload.files.has(spec.name)) return fail(res, 422, "missing_file", `${spec.name} wasn't uploaded`);
        const start = upload.start as { version: string; build: number; notes?: string; edSignature?: string; minimumSystemVersion?: string };
        if (app.updater === "sparkle") {
          const dmg = declared.find((item) => item.role === "dmg")!;
          const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(app.sparklePublicKey!, "base64")]), format: "der", type: "spki" });
          if (!start.edSignature || !verify(null, upload.files.get(dmg.name)!, key, Buffer.from(start.edSignature, "base64"))) {
            return fail(res, 422, "bad_signature", "edSignature doesn't verify");
          }
        }
        const release: StoredRelease = {
          version: start.version,
          build: start.build,
          notes: start.notes,
          minimumSystemVersion: start.minimumSystemVersion,
          publishedAt: new Date().toISOString(),
          withdrawn: false,
          edSignature: start.edSignature,
          files: declared.map((spec) => ({
            ...spec,
            sha512: createHash("sha512").update(upload.files.get(spec.name)!).digest("base64"),
            data: upload.files.get(spec.name)!,
          })),
        };
        app.releases.push(release);
        upload.committed = true;
        return send(res, 201, publicRelease(release));
      }
    }
    return fail(res, 404, "not_found", "Not found");
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((error: Error) => fail(res, 500, "internal", error.message));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    adminToken,
    apps,
    tokens,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
