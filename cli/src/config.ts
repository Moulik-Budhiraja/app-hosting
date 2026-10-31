import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT, usage } from "./errors.js";

export interface RemoteConfig {
  url: string;
}

export interface Config {
  remotes: Record<string, RemoteConfig>;
  appleIssuerId?: string;
}

const REMOTE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function configDir(env: NodeJS.ProcessEnv): string {
  return env.APPS_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".config", "apps");
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "config.json");
}

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<Config> {
  const path = configPath(env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { remotes: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`${path} isn't valid JSON. Fix or delete it.`, EXIT.failure, "BAD_CONFIG");
  }
  const value = (parsed ?? {}) as Partial<Config>;
  const remotes: Record<string, RemoteConfig> = {};
  for (const [name, remote] of Object.entries(value.remotes ?? {})) {
    if (remote && typeof remote.url === "string") remotes[name] = { url: remote.url };
  }
  const config: Config = { remotes };
  if (typeof value.appleIssuerId === "string" && value.appleIssuerId) config.appleIssuerId = value.appleIssuerId;
  return config;
}

export async function saveConfig(env: NodeJS.ProcessEnv, config: Config): Promise<void> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function checkRemoteName(name: string): string {
  if (!REMOTE_NAME.test(name)) {
    throw usage(`"${name}" isn't a valid remote name. Use lowercase letters, digits and dashes.`);
  }
  return name;
}

export function normalizeUrl(raw: string, what = "URL"): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw usage(`${what} "${raw}" isn't a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw usage(`${what} must use https.`);
  if (url.username || url.password) throw usage(`${what} must not contain credentials.`);
  if (url.search || url.hash) throw usage(`${what} must not have a query or fragment.`);
  return url.toString().replace(/\/+$/, "");
}

export function getRemote(config: Config, name: string): RemoteConfig {
  const remote = config.remotes[name];
  if (!remote) {
    throw new CliError(`Unknown remote "${name}". Add it with: apps remote add ${name} <url>`, EXIT.usage, "UNKNOWN_REMOTE");
  }
  return remote;
}
