import net from "node:net";
import type { AddressInfo } from "node:net";
import { matchesFileSignature, scanReadable } from "../../src/security/clamavScanner";

// No ClamAV host in the environment: only explicit options can reach a scanner.
jest.mock("../../src/config/env", () => ({
  env: { CLAMAV_HOST: undefined, CLAMAV_PORT: 3310, CLAMAV_TIMEOUT_MS: 15000 }
}));

type Behavior = "ok" | "found" | "silent" | "hangup";

interface FakeClamd {
  port: number;
  payload: () => Buffer;
  close: () => Promise<void>;
}

const INSTREAM_HEADER_LENGTH = "zINSTREAM\0".length;

// Minimal clamd INSTREAM server: reads length-prefixed chunks until the zero-length terminator.
async function startFakeClamd(behavior: Behavior): Promise<FakeClamd> {
  const sockets = new Set<net.Socket>();
  const received: Buffer[] = [];

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer: Buffer = Buffer.alloc(0);
    let headerSeen = false;
    let finished = false;

    socket.on("data", (data: Buffer) => {
      if (finished) return;
      buffer = Buffer.concat([buffer, data]);
      if (!headerSeen) {
        if (buffer.length < INSTREAM_HEADER_LENGTH) return;
        buffer = buffer.subarray(INSTREAM_HEADER_LENGTH);
        headerSeen = true;
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          finished = true;
          if (behavior === "ok") socket.end("stream: OK\0");
          else if (behavior === "found") socket.end("stream: Eicar-Test-Signature FOUND\0");
          else if (behavior === "hangup") socket.destroy();
          return;
        }
        if (buffer.length < 4 + size) return;
        received.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    payload: () => Buffer.concat(received),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function* chunks(...parts: string[]): AsyncGenerator<Buffer> {
  for (const part of parts) yield Buffer.from(part);
}

describe("upload file verification", () => {
  test("validates JPEG, PNG, PDF and MP4 signatures", () => {
    expect(matchesFileSignature("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe(true);
    expect(matchesFileSignature("image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(matchesFileSignature("application/pdf", Buffer.from("%PDF-1.7"))).toBe(true);
    expect(matchesFileSignature("video/mp4", Buffer.from("0000ftypisom"))).toBe(true);
    expect(matchesFileSignature("application/pdf", Buffer.from("<html>"))).toBe(false);
  });

  test("rejects short prefixes and unknown content types", () => {
    expect(matchesFileSignature("image/jpeg", Buffer.from([0xff, 0xd8]))).toBe(false);
    expect(matchesFileSignature("video/mp4", Buffer.from("0000ftyp"))).toBe(false);
    expect(matchesFileSignature("image/gif", Buffer.from("GIF89a"))).toBe(false);
    expect(matchesFileSignature("image/png", Buffer.alloc(0))).toBe(false);
  });

  test("fails closed when ClamAV is not configured", async () => {
    await expect(scanReadable(chunks("sample"))).rejects.toThrow("CLAMAV_HOST");
  });
});

describe("scanReadable against a ClamAV socket", () => {
  let clamd: FakeClamd | undefined;
  afterEach(async () => {
    await clamd?.close();
    clamd = undefined;
  });

  test("streams every chunk and reports a clean file", async () => {
    clamd = await startFakeClamd("ok");
    const seen: string[] = [];
    const result = await scanReadable(chunks("hello ", "world"), {
      host: "127.0.0.1",
      port: clamd.port,
      onChunk: (chunk) => seen.push(chunk.toString())
    });
    expect(result).toEqual({ clean: true, response: "stream: OK" });
    expect(seen).toEqual(["hello ", "world"]);
    expect(clamd.payload().toString()).toBe("hello world");
  });

  test("reports an infected file as not clean", async () => {
    clamd = await startFakeClamd("found");
    const result = await scanReadable(chunks("X5O!P%@AP"), { host: "127.0.0.1", port: clamd.port });
    expect(result.clean).toBe(false);
    expect(result.response).toContain("FOUND");
  });

  test("rejects when the scanner is unreachable", async () => {
    const closed = await startFakeClamd("ok");
    const { port } = closed;
    await closed.close();
    await expect(scanReadable(chunks("data"), { host: "127.0.0.1", port })).rejects.toThrow("ClamAV scanner unavailable");
  });

  test("rejects when the scanner never answers", async () => {
    clamd = await startFakeClamd("silent");
    await expect(
      scanReadable(chunks("data"), { host: "127.0.0.1", port: clamd.port, timeoutMs: 100 })
    ).rejects.toThrow("timed out");
  });

  test("rejects when the connection closes without a verdict", async () => {
    clamd = await startFakeClamd("hangup");
    await expect(scanReadable(chunks("data"), { host: "127.0.0.1", port: clamd.port })).rejects.toThrow(
      /without a verdict|scanner unavailable/
    );
  });
});
