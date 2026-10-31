import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CliError, EXIT } from "./errors.js";

export interface Prompter {
  /** Asks without echoing the answer. */
  secret(label: string): Promise<string>;
  line(label: string): Promise<string>;
}

type Input = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
type Output = NodeJS.WritableStream & { isTTY?: boolean };

export function terminalPrompter(input: Input, output: Output): Prompter {
  const requireTty = (what: string) => {
    if (!input.isTTY || !output.isTTY) {
      throw new CliError(`${what} needs an interactive terminal.`, EXIT.usage, "INTERACTIVE_REQUIRED");
    }
  };
  return {
    async secret(label) {
      requireTty("Entering a secret");
      const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      Object.assign(muted, { isTTY: true, columns: 80, rows: 24 });
      output.write(label);
      const rl = createInterface({ input, output: muted, terminal: true });
      try {
        const answer = await rl.question("");
        return answer.trim();
      } finally {
        rl.close();
        output.write("\n");
      }
    },
    async line(label) {
      requireTty("This question");
      const rl = createInterface({ input, output, terminal: true });
      try {
        return (await rl.question(label)).trim();
      } finally {
        rl.close();
      }
    },
  };
}

export async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  input.setEncoding?.("utf8");
  for await (const chunk of input) text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  return text;
}
