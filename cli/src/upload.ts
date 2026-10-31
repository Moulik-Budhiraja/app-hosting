import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { CliError, EXIT } from "./errors.js";

export interface FileDigest {
  size: number;
  sha256: string;
}

export async function digestFile(path: string): Promise<FileDigest> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`${path} doesn't exist.`, EXIT.usage, "MISSING_FILE");
    }
    throw error;
  }
  if (!info.isFile()) throw new CliError(`${path} isn't a file.`, EXIT.usage, "MISSING_FILE");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { size: info.size, sha256: hash.digest("hex") };
}

export interface PutResult {
  status: number;
  body: string;
}

/** Streams a file to `url` with PUT, reporting bytes sent. */
export function putFile(
  url: string,
  token: string,
  path: string,
  size: number,
  onProgress?: (sent: number) => void,
): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "content-length": String(size),
        accept: "application/json",
      },
    });
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      response.on("error", fail);
    });
    request.on("error", (error) => fail(new CliError(`Upload of ${path} failed: ${error.message}`, EXIT.network, "NETWORK")));
    const file = createReadStream(path);
    let sent = 0;
    file.on("data", (chunk) => {
      sent += (chunk as Buffer).length;
      onProgress?.(sent);
    });
    file.on("error", (error) => {
      request.destroy();
      fail(error);
    });
    file.pipe(request);
  });
}
