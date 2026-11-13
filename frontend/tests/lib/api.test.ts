import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchHealth, parseFrame, streamAi, type StreamEvent } from "../../lib/api";

const enc = new TextEncoder();

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    }
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("parseFrame", () => {
  it("parses token, done and error frames", () => {
    expect(parseFrame('event: token\ndata: {"text":"Hi "}')).toEqual({ type: "token", text: "Hi " });
    expect(parseFrame('event: done\ndata: {"fallback":true}')).toEqual({ type: "done", fallback: true });
    expect(parseFrame('event: error\ndata: {"code":"X","message":"boom"}')).toEqual({
      type: "error",
      code: "X",
      message: "boom"
    });
  });

  it("ignores comments and unknown events", () => {
    expect(parseFrame(": keep-alive")).toBeNull();
    expect(parseFrame('event: whatever\ndata: {"a":1}')).toBeNull();
  });

  it("rejects a frame that is not valid JSON", () => {
    expect(() => parseFrame("event: token\ndata: {nope")).toThrow(ApiError);
  });

  it("rejects a meta frame whose triage breaks the schema (the UI never trusts raw output)", () => {
    const bad = JSON.stringify({
      fallback: false,
      triage: { headline: "h", items: [{ id: "a", priority: "urgent", reason: "r" }] }
    });
    expect(() => parseFrame(`event: meta\ndata: ${bad}`)).toThrow(/BAD_FRAME|unexpected/i);
  });
});

describe("streamAi", () => {
  it("reassembles frames split across network chunks and sends the session header", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'event: meta\ndata: {"fallback":false}\n\nevent: tok',
        'en\ndata: {"text":"Hel',
        'lo"}\n\nevent: done\ndata: {"fallback":false}\n\n'
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(streamAi("summary", { language: "English" }, { sessionId: "sess-1" }));
    expect(events.map((e) => e.type)).toEqual(["meta", "token", "done"]);
    expect(events[1]).toEqual({ type: "token", text: "Hello" });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["X-Session-Id"]).toBe("sess-1");
  });

  it("flushes a final SSE frame when the stream closes without a blank-line terminator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(['event: token\ndata: {"text":"final token"}\n\nevent: done\ndata: {"fallback":false}'])
      )
    );

    const events = await collect(streamAi("summary", {}, { sessionId: "s-final" }));
    expect(events).toEqual([
      { type: "token", text: "final token" },
      { type: "done", fallback: false }
    ]);
  });

  it("turns a 429 into a typed ApiError with the server's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Too many requests." } }), {
            status: 429,
            headers: { "content-type": "application/json" }
          })
      )
    );
    await expect(collect(streamAi("talk", {}, { sessionId: "s" }))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Too many requests."
    });
  });

  it("turns a network failure into a friendly ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(collect(streamAi("talk", {}, { sessionId: "s" }))).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("fetchHealth", () => {
  it("is true only for a well-formed { ok: true } answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    await expect(fetchHealth()).resolves.toBe(true);
  });

  it("is false (never throws) for a wrong shape, an HTTP error or a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: "yes" }), { status: 200 }))
    );
    await expect(fetchHealth()).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 }))
    );
    await expect(fetchHealth()).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(fetchHealth()).resolves.toBe(false);
  });
});

describe("acknowledgeAlert", () => {
  it("posts to the acknowledge endpoint with the bearer token and returns the data field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { alertId: "a/1", classification: { severity: "P0" } } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { acknowledgeAlert } = await import("../../lib/api");

    const result = await acknowledgeAlert("tok", "a/1");

    expect(result.alertId).toBe("a/1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/alerts/a%2F1/acknowledge");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});
