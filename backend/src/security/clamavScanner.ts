import net from "node:net";
import { once } from "node:events";
import { env } from "../config/env";
import { errorMessage } from "../utils/errors";

export interface ScanOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  // Called with every chunk as it is streamed to ClamAV (used to capture the file signature).
  onChunk?: (chunk: Buffer) => void;
}

export interface ScanResult {
  clean: boolean;
  response: string;
}

type ScanInput = AsyncIterable<Buffer | Uint8Array | string>;

// Streams a file to ClamAV and returns its verdict.
export async function scanReadable(readable: ScanInput, options: ScanOptions = {}): Promise<ScanResult> {
  const host = options.host ?? env.CLAMAV_HOST;
  const port = options.port ?? env.CLAMAV_PORT;
  const timeoutMs = options.timeoutMs ?? env.CLAMAV_TIMEOUT_MS;
  if (!host) throw new Error("CLAMAV_HOST is required; uploaded objects must remain quarantined until scanned");

  const socket = net.createConnection({ host, port });
  socket.setTimeout(timeoutMs);
  let response = "";
  let settled = false;
  return new Promise<ScanResult>((resolve, reject) => {
    socket.once("connect", async () => {
      try {
        socket.write(Buffer.from("zINSTREAM\0"));
        for await (const value of readable) {
          const chunk = Buffer.isBuffer(value) ? value : typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
          options.onChunk?.(chunk);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length, 0);
          if (!socket.write(Buffer.concat([length, chunk]))) await once(socket, "drain");
        }
        const end = Buffer.alloc(4);
        end.writeUInt32BE(0, 0);
        socket.end(end);
      } catch (error: unknown) {
        socket.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.includes("\0") || /(?:OK|FOUND|ERROR)$/.test(response.trim())) {
        settled = true;
        resolve({ clean: /: OK(?:\0|$)/.test(response.trim()), response: response.replace(/\0/g, "").trim() });
        socket.destroy();
      }
    });
    socket.once("timeout", () => socket.destroy(new Error("ClamAV scan timed out")));
    socket.once("error", (error: Error) => reject(new Error(`ClamAV scanner unavailable: ${error.message}`)));
    socket.once("close", () => {
      if (!settled) reject(new Error("ClamAV closed the connection without a verdict"));
    });
  });
}

// Checks file start bytes against the declared type.
export function matchesFileSignature(contentType: string, prefix: Buffer): boolean {
  if (contentType === "image/jpeg")
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (contentType === "image/png")
    return prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "application/pdf") return prefix.subarray(0, 5).toString("ascii") === "%PDF-";
  if (contentType === "video/mp4") return prefix.length >= 12 && prefix.subarray(4, 8).toString("ascii") === "ftyp";
  return false;
}
