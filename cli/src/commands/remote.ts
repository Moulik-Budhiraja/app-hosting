import { ApiClient } from "../api.js";
import { checkRemoteName, getRemote, loadConfig, normalizeUrl, saveConfig } from "../config.js";
import type { Deps, Out } from "../context.js";
import { table } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import { readAll } from "../prompt.js";
import { TOKEN_SERVICE } from "../secrets.js";

export async function remoteCommand(deps: Deps, out: Out, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const config = await loadConfig(deps.env);

  if (action === "add") {
    if (rest.length !== 2) throw usage("Usage: apps remote add <name> <url>");
    const name = checkRemoteName(rest[0]!);
    const url = normalizeUrl(rest[1]!);
    const existing = config.remotes[name];
    if (existing && existing.url !== url) {
      throw new CliError(
        `Remote ${name} already points at ${existing.url}. Remove it first: apps remote remove ${name}`,
        EXIT.usage,
        "REMOTE_EXISTS",
      );
    }
    config.remotes[name] = { url };
    await saveConfig(deps.env, config);
    out.result([`Added remote ${name} → ${url}`, `Log in with: apps login ${name}`], { name, url });
    return;
  }

  if (action === "remove" || action === "rm") {
    if (rest.length !== 1) throw usage("Usage: apps remote remove <name>");
    const name = rest[0]!;
    getRemote(config, name);
    delete config.remotes[name];
    await saveConfig(deps.env, config);
    const forgot = await deps.secrets.delete(TOKEN_SERVICE, name).catch(() => false);
    out.result(`Removed remote ${name}${forgot ? " and its saved token" : ""}.`, { name, removed: true, tokenRemoved: forgot });
    return;
  }

  if (action === "list" || action === "ls" || action === undefined) {
    if (rest.length) throw usage("Usage: apps remote list");
    const remotes = [];
    for (const [name, remote] of Object.entries(config.remotes).sort(([a], [b]) => a.localeCompare(b))) {
      const loggedIn = Boolean(await deps.secrets.get(TOKEN_SERVICE, name).catch(() => null));
      remotes.push({ name, url: remote.url, loggedIn });
    }
    const human = remotes.length
      ? table(remotes.map((remote) => [remote.name, remote.url, remote.loggedIn ? "logged in" : "not logged in"]))
      : ["No remotes yet. Add one with: apps remote add <name> <url>"];
    out.result(human, remotes);
    return;
  }

  throw usage(`Unknown remote action "${action}". Use add, remove or list.`);
}

export async function loginCommand(
  deps: Deps,
  out: Out,
  positionals: string[],
  options: { tokenStdin: boolean },
): Promise<void> {
  if (positionals.length !== 1) throw usage("Usage: apps login <remote> [--token-stdin]");
  const name = positionals[0]!;
  const remote = getRemote(await loadConfig(deps.env), name);
  const token = options.tokenStdin
    ? (await readAll(deps.stdin)).trim()
    : await deps.prompt.secret(`Admin token for ${name} (${remote.url}): `);
  if (!token) throw usage("No token given.");

  const api = new ApiClient(remote.url, name, token, deps.fetch);
  const who = await api.whoami();
  if (who.scope !== "admin") {
    throw new CliError(
      `That's a publish token for ${who.app}. apps login needs ${name}'s admin token (APPS_ADMIN_TOKEN on the server).`,
      EXIT.auth,
      "NEEDS_ADMIN",
    );
  }
  await deps.secrets.set(TOKEN_SERVICE, name, token);
  out.result(`Logged in to ${name} (${remote.url}).`, { remote: name, url: remote.url, scope: who.scope });
}

export async function logoutCommand(deps: Deps, out: Out, positionals: string[]): Promise<void> {
  if (positionals.length !== 1) throw usage("Usage: apps logout <remote>");
  const name = positionals[0]!;
  const removed = await deps.secrets.delete(TOKEN_SERVICE, name);
  out.result(removed ? `Logged out of ${name}.` : `Wasn't logged in to ${name}.`, { remote: name, removed });
}
