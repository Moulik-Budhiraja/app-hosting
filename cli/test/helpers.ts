import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Deps } from "../src/context.js";
import type { GhOptions, GhRunner } from "../src/gh.js";
import { run } from "../src/main.js";
import { memoryStore } from "../src/secrets.js";

export interface GhCall { args: string[]; options?: GhOptions }

export function stubGh(responder: (args: string[]) => string = () => ""): GhRunner & { calls: GhCall[] } {
  const calls: GhCall[] = [];
  return {
    calls,
    async run(args, options) {
      calls.push({ args, options });
      return responder(args);
    },
  };
}

export interface Harness {
  deps: Deps;
  secrets: ReturnType<typeof memoryStore>;
  gh: ReturnType<typeof stubGh>;
  home: string;
  dir: string;
  answers: string[];
  run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup(): Promise<void>;
}

export async function harness(options: { env?: NodeJS.ProcessEnv; gh?: (args: string[]) => string; stdin?: string } = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "apps-cli-home-"));
  const dir = await mkdtemp(join(tmpdir(), "apps-cli-repo-"));
  const secrets = memoryStore();
  const gh = stubGh(options.gh);
  const answers: string[] = [];
  const deps: Deps = {
    env: { HOME: home, APPS_CONFIG_DIR: join(home, "config"), ...options.env },
    cwd: dir,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    secrets,
    gh,
    prompt: {
      async secret() { return answers.shift() ?? ""; },
      async line() { return answers.shift() ?? ""; },
    },
    fetch: globalThis.fetch,
  };
  return {
    deps,
    secrets,
    gh,
    home,
    dir,
    answers,
    async run(...argv) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = "";
      let err = "";
      stdout.on("data", (chunk) => { out += chunk; });
      stderr.on("data", (chunk) => { err += chunk; });
      const stdin = new PassThrough();
      stdin.end(options.stdin ?? "");
      const code = await run(argv, { ...deps, stdin, stdout, stderr });
      return { code, stdout: out, stderr: err };
    },
    async cleanup() {
      await rm(home, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
