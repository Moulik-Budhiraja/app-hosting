import { spawn } from "node:child_process";
import { CliError, EXIT } from "./errors.js";

export interface GhOptions {
  /** Written to gh's stdin. Secrets always go this way, never in argv. */
  input?: string;
  cwd?: string;
}

export interface GhRunner {
  run(args: string[], options?: GhOptions): Promise<string>;
}

export function spawnGh(): GhRunner {
  return {
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn("gh", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", (error: NodeJS.ErrnoException) => {
          reject(error.code === "ENOENT"
            ? new CliError("GitHub's gh CLI isn't installed. Install it with: brew install gh", EXIT.failure, "GH_MISSING")
            : error);
        });
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else {
            const command = ["gh", ...args.slice(0, 3)].join(" ");
            reject(new CliError(`${command} failed: ${stderr.trim() || `exit ${code}`}`, EXIT.failure, "GH_FAILED"));
          }
        });
        child.stdin.end(options.input ?? "");
      });
    },
  };
}
