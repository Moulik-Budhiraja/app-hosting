import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { buildNumberCommand, iconCommand, releasesCommand, statusCommand, tokenCommand, withdrawCommand } from "./commands/manage.js";
import { publishCommand } from "./commands/publish.js";
import { loginCommand, logoutCommand, remoteCommand } from "./commands/remote.js";
import { createCommand, initCommand } from "./commands/setup.js";
import { Out, type Deps } from "./context.js";
import { asCliError, EXIT, usage } from "./errors.js";
import { spawnGh } from "./gh.js";
import { terminalPrompter } from "./prompt.js";
import { keyringStore } from "./secrets.js";

const ROOT_HELP = `apps: ship auto-updating macOS and Windows apps to an apps remote.

Remotes (like git: each app lives on one remote):
  apps remote add <name> <url>     Add a remote, e.g. apps remote add moulik https://apps.moulik.dev
  apps remote remove <name>        Remove a remote and its saved token
  apps remote list                 List remotes
  apps login <remote>              Save the remote's admin token in the keychain (--token-stdin to pipe it)
  apps logout <remote>             Forget the token

Setting up an app (run in the app's repo):
  apps create <app> --remote <r> --updater sparkle|electron [--title T] [--kind native|electron]
              [--platforms mac,windows]
                                   Register the app and write apps.json (platforms default to mac)
  apps init [--repo owner/name] [--signing-dir dir] [--apple-issuer-id id] [--key-id id] [--dry-run]
                                   Connect the GitHub repo: environment, secrets, release workflow

Releasing:
  apps publish --version X.Y.Z [--platform mac|windows] [--build N] [--notes-file <path>]
               [--minimum-system-version v] [--icon <png>] and the platform's files:
               macOS:   --dmg <path> [--zip <path>] [--blockmap <path>]
               Windows: --installer <path> [--blockmap <path>]
                                   --platform defaults to windows with --installer, else mac
  apps icon <icon.png>             Set the icon on the app's download page (--remove to drop it, admin)
  apps status [--expect X.Y.Z] [--platform p]
                                   Latest release per platform and whether the live feeds match
  apps releases [--app a --remote r]
  apps withdraw <version>          Take a release out of the feed (admin)
  apps restore <version>           Put it back (admin)
  apps token create|list|revoke    Publish tokens for this app (admin)
  apps build-number <version>      The default build for a version (1.2.3 → 100200300)

Options for every command:
  -C <dir>     Run as if in <dir>
  --json       Machine-readable output
  -h, --help   Help

Environment (CI):
  APPS_TOKEN            Token to use instead of the keychain
  SPARKLE_PRIVATE_KEY   Sparkle key (base64 seed) to use instead of the keychain
  APPS_CONFIG_DIR       Config directory (default ~/.config/apps)
`;

const COMMON = {
  json: { type: "boolean" },
  C: { type: "string", short: "C" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

const TARGET = {
  app: { type: "string" },
  remote: { type: "string" },
} as const satisfies ParseArgsConfig["options"];

const COMMAND_OPTIONS = {
  remote: {},
  login: { "token-stdin": { type: "boolean" } },
  logout: {},
  create: { remote: { type: "string" }, updater: { type: "string" }, title: { type: "string" }, kind: { type: "string" }, platforms: { type: "string" } },
  init: {
    repo: { type: "string" },
    "signing-dir": { type: "string" },
    "apple-issuer-id": { type: "string" },
    "key-id": { type: "string" },
    "dry-run": { type: "boolean" },
  },
  publish: {
    version: { type: "string" },
    platform: { type: "string" },
    installer: { type: "string" },
    build: { type: "string" },
    "notes-file": { type: "string" },
    dmg: { type: "string" },
    zip: { type: "string" },
    blockmap: { type: "string" },
    "minimum-system-version": { type: "string" },
    icon: { type: "string" },
  },
  status: { expect: { type: "string" }, platform: { type: "string" } },
  releases: TARGET,
  withdraw: TARGET,
  restore: TARGET,
  token: { ...TARGET, label: { type: "string" } },
  icon: { ...TARGET, remove: { type: "boolean" } },
  "build-number": {},
} as const satisfies Record<string, ParseArgsConfig["options"]>;

type Command = keyof typeof COMMAND_OPTIONS;

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function defaultDeps(): Deps {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    secrets: keyringStore(),
    gh: spawnGh(),
    prompt: terminalPrompter(process.stdin, process.stderr),
    fetch: globalThis.fetch,
  };
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined || first === "help" || first === "-h" || first === "--help") {
    deps.stdout.write(ROOT_HELP);
    return first === undefined ? EXIT.usage : EXIT.ok;
  }
  if (first === "--version" || first === "-v") {
    deps.stdout.write(`${packageVersion()}\n`);
    return EXIT.ok;
  }

  const json = argv.includes("--json");
  const out = new Out(deps, json);
  try {
    if (!(first in COMMAND_OPTIONS)) throw usage(`Unknown command "${first}". Run apps --help.`);
    const command = first as Command;
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...COMMON, ...COMMAND_OPTIONS[command] },
      allowPositionals: true,
      strict: true,
    });
    const v = values as Record<string, string | boolean | undefined>;
    if (v.help) {
      deps.stdout.write(ROOT_HELP);
      return EXIT.ok;
    }
    const dir = resolve(deps.cwd, typeof v.C === "string" ? v.C : ".");
    const str = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : undefined);

    switch (command) {
      case "remote":
        await remoteCommand(deps, out, positionals);
        break;
      case "login":
        await loginCommand(deps, out, positionals, { tokenStdin: Boolean(v["token-stdin"]) });
        break;
      case "logout":
        await logoutCommand(deps, out, positionals);
        break;
      case "create":
        await createCommand(deps, out, positionals, { dir, remote: str("remote"), updater: str("updater"), title: str("title"), kind: str("kind"), platforms: str("platforms") });
        break;
      case "init":
        if (positionals.length) throw usage("apps init takes no arguments.");
        await initCommand(deps, out, {
          dir,
          repo: str("repo"),
          signingDir: str("signing-dir"),
          appleIssuerId: str("apple-issuer-id"),
          keyId: str("key-id"),
          dryRun: Boolean(v["dry-run"]),
        });
        break;
      case "publish":
        if (positionals.length) throw usage("apps publish takes options only. Run apps --help.");
        await publishCommand(deps, out, {
          dir,
          version: str("version"),
          platform: str("platform"),
          build: str("build"),
          notesFile: str("notes-file"),
          dmg: str("dmg"),
          zip: str("zip"),
          blockmap: str("blockmap"),
          installer: str("installer"),
          minimumSystemVersion: str("minimum-system-version"),
          icon: str("icon"),
        });
        break;
      case "status":
        if (positionals.length) throw usage("apps status takes no arguments.");
        return await statusCommand(deps, out, { dir, expect: str("expect"), platform: str("platform") });
      case "releases":
        if (positionals.length) throw usage("Usage: apps releases [--app a --remote r]");
        await releasesCommand(deps, out, { dir, app: str("app"), remote: str("remote") });
        break;
      case "withdraw":
      case "restore":
        await withdrawCommand(deps, out, positionals, { dir, app: str("app"), remote: str("remote"), withdraw: command === "withdraw" });
        break;
      case "token":
        await tokenCommand(deps, out, positionals, { dir, app: str("app"), remote: str("remote"), label: str("label") });
        break;
      case "icon":
        await iconCommand(deps, out, positionals, { dir, app: str("app"), remote: str("remote"), remove: Boolean(v.remove) });
        break;
      case "build-number":
        buildNumberCommand(out, positionals);
        break;
    }
    return EXIT.ok;
  } catch (error) {
    const failure = asCliError(error);
    if (json) {
      deps.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message } })}\n`);
    } else {
      deps.stderr.write(`apps: ${failure.message}\n`);
    }
    return failure.exitCode;
  }
}
