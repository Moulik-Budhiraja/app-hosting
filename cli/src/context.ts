import { ApiClient } from "./api.js";
import { CliError, EXIT } from "./errors.js";
import type { GhRunner } from "./gh.js";
import type { Prompter } from "./prompt.js";
import { TOKEN_SERVICE, type SecretStore } from "./secrets.js";

export type Input = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
export type Output = NodeJS.WritableStream & { isTTY?: boolean };

export interface Deps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: Input;
  stdout: Output;
  stderr: Output;
  secrets: SecretStore;
  gh: GhRunner;
  prompt: Prompter;
  fetch: typeof fetch;
}

/** Output for one command: human text, or a single JSON document with --json. */
export class Out {
  readonly json: boolean;
  private readonly deps: Deps;

  constructor(deps: Deps, json: boolean) {
    this.deps = deps;
    this.json = json;
  }

  /** The command's result. Human lines go to stdout; with --json, `data` does. */
  result(human: string | string[], data: unknown): void {
    if (this.json) {
      this.deps.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
    const lines = Array.isArray(human) ? human : [human];
    if (lines.length) this.deps.stdout.write(`${lines.join("\n")}\n`);
  }

  /** Progress and side notes: stderr, and only in human mode. */
  info(message: string): void {
    if (!this.json) this.deps.stderr.write(`${message}\n`);
  }

  warn(message: string): void {
    this.deps.stderr.write(`Warning: ${message}\n`);
  }
}

export async function tokenFor(deps: Deps, remoteName: string): Promise<string | undefined> {
  const fromEnv = deps.env.APPS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return (await deps.secrets.get(TOKEN_SERVICE, remoteName)) ?? undefined;
}

export async function client(deps: Deps, remoteName: string, url: string): Promise<ApiClient> {
  return new ApiClient(url, remoteName, await tokenFor(deps, remoteName), deps.fetch);
}

export async function requireAdmin(deps: Deps, api: ApiClient): Promise<void> {
  const who = await api.whoami();
  if (who.scope !== "admin") {
    throw new CliError(
      `This needs the admin token for ${api.remoteName}, but the token in use only publishes ${who.app}. ${
        deps.env.APPS_TOKEN?.trim() ? "Unset APPS_TOKEN and run" : "Run"
      }: apps login ${api.remoteName}`,
      EXIT.auth,
      "NEEDS_ADMIN",
    );
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function table(rows: string[][]): string[] {
  if (!rows.length) return [];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  ").trimEnd());
}
