import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError, EXIT, usage } from "./errors.js";

// Matches the server's limits, so a bad icon fails before anything is uploaded.
export const MAX_ICON_SIZE = 1 << 20;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads and checks an icon PNG. scripts/mac/app-icon.sh makes one from an .app. */
export async function readIcon(dir: string, path: string): Promise<Buffer> {
  const file = resolve(dir, path);
  if (file.endsWith(".app") || file.endsWith(".app/")) {
    throw usage(`${path} is an app. Make a PNG of its icon first: scripts/mac/app-icon.sh ${path} icon.png`);
  }
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`${path} doesn't exist.`, EXIT.usage, "MISSING_FILE");
    throw error;
  }
  if (data.length > MAX_ICON_SIZE) throw usage(`${path} is over 1 MiB. A 256-pixel PNG is plenty.`);
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString("latin1", 12, 16) !== "IHDR") {
    throw usage(`${path} isn't a PNG.`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 16 || height < 16 || width > 2048 || height > 2048) {
    throw usage(`${path} is ${width}×${height}. Icons must be 16 to 2048 pixels on each side.`);
  }
  return data;
}
