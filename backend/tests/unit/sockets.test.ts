import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server } from "socket.io";
import { verifyAccessToken } from "../../src/auth/tokens";
import { env } from "../../src/config/env";
import {
  attachSocketServer,
  authenticateSocket,
  forwardEvent,
  handleConnection,
  type RealtimeServer,
  type RealtimeSocket
} from "../../src/sockets";
import { callArgs, flushPromises } from "../helpers/mocks";

jest.mock("socket.io", () => ({ Server: jest.fn() }));
jest.mock("ioredis", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@socket.io/redis-adapter", () => ({ createAdapter: jest.fn() }));
jest.mock("../../src/auth/tokens", () => ({ verifyAccessToken: jest.fn() }));
jest.mock("../../src/config/env", () => ({ env: {} }));

const ServerMock = Server as unknown as jest.Mock;
const RedisMock = Redis as unknown as jest.Mock;
const createAdapterMock = createAdapter as unknown as jest.Mock;
const verifyMock = verifyAccessToken as unknown as jest.Mock;

const claims = { sub: "U-1", tenantId: "T-1", roles: ["operator"] };

// Builds a socket double with the fields the handlers use.
function fakeSocket(auth?: Record<string, unknown>) {
  const socket = { handshake: { auth }, data: {} as Record<string, unknown>, join: jest.fn(), on: jest.fn() };
  return { socket, asSocket: (): RealtimeSocket => socket as unknown as RealtimeSocket };
}

// Builds a server double whose to() returns one shared emitter.
function fakeIo() {
  const emit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit });
  return { emit, to, asServer: (): RealtimeServer => ({ to }) as unknown as RealtimeServer };
}

describe("socket authentication", () => {
  test("rejects a handshake without a token", () => {
    const { socket, asSocket } = fakeSocket({});
    const next = jest.fn();

    authenticateSocket(asSocket(), next);

    expect((callArgs(next)[0] as Error).message).toBe("UNAUTHORIZED");
    expect(verifyMock).not.toHaveBeenCalled();
    expect(socket.data).toEqual({});
  });

  test("rejects a handshake with no auth object or a non-string token", () => {
    for (const auth of [undefined, { token: 123 }, { token: "" }]) {
      const next = jest.fn();
      authenticateSocket(fakeSocket(auth).asSocket(), next);
      expect((callArgs(next)[0] as Error).message).toBe("UNAUTHORIZED");
    }
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test("rejects a token that fails verification", () => {
    verifyMock.mockImplementation(() => {
      throw new Error("jwt expired");
    });
    const { socket, asSocket } = fakeSocket({ token: "expired" });
    const next = jest.fn();

    authenticateSocket(asSocket(), next);

    expect((callArgs(next)[0] as Error).message).toBe("UNAUTHORIZED");
    expect(socket.data.auth).toBeUndefined();
  });

  test("stores the verified claims and lets the connection through", () => {
    verifyMock.mockReturnValue(claims);
    const { socket, asSocket } = fakeSocket({ token: "good" });
    const next = jest.fn();

    authenticateSocket(asSocket(), next);

    expect(verifyMock).toHaveBeenCalledWith("good");
    expect(socket.data.auth).toEqual(claims);
    expect(next).toHaveBeenCalledWith();
  });
});

describe("socket rooms", () => {
  test("puts the socket into its tenant room", () => {
    const { socket, asSocket } = fakeSocket();
    socket.data.auth = claims;

    handleConnection(asSocket());

    expect(socket.join).toHaveBeenCalledWith("tenant:T-1");
  });

  test("joins a site room only for valid site ids of the socket's own tenant", () => {
    const { socket, asSocket } = fakeSocket();
    socket.data.auth = claims;
    handleConnection(asSocket());
    const [event, subscribe] = callArgs(socket.on) as [string, (siteId: unknown) => void];
    expect(event).toBe("site:subscribe");

    subscribe("site-1");
    subscribe(42);
    subscribe({ id: "site-2" });
    subscribe("");
    subscribe("bad id!");
    subscribe("../tenant:T-2");
    subscribe("x".repeat(101));

    expect(socket.join).toHaveBeenCalledTimes(2);
    expect(socket.join).toHaveBeenLastCalledWith("tenant:T-1:site:site-1");
  });
});

describe("forwarding Redis events", () => {
  test("sends a classification to the tenant room and the site room", () => {
    const { emit, to, asServer } = fakeIo();
    const event = { tenantId: "T-1", siteId: "S-1", alertId: "A-1" };

    forwardEvent(asServer(), "ai:classification:completed", JSON.stringify(event));

    expect(to.mock.calls).toEqual([["tenant:T-1"], ["tenant:T-1:site:S-1"]]);
    expect(emit.mock.calls).toEqual([
      ["ai:classification:completed", event],
      ["site:alert:classified", event]
    ]);
  });

  test("uses the IoT event names for the IoT channel", () => {
    const { emit, asServer } = fakeIo();
    const event = { tenantId: "T-1", siteId: "S-1" };

    forwardEvent(asServer(), "iot:event:changed", JSON.stringify(event));

    expect(emit.mock.calls).toEqual([
      ["iot:event:changed", event],
      ["site:iot:event", event]
    ]);
  });

  test("sends to the tenant room only when the event has no site", () => {
    const { emit, to, asServer } = fakeIo();

    forwardEvent(asServer(), "iot:event:changed", JSON.stringify({ tenantId: "T-1" }));

    expect(to.mock.calls).toEqual([["tenant:T-1"]]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  test("drops events without a usable tenant id instead of sending them anywhere", () => {
    const { to, asServer } = fakeIo();
    const payloads = [{}, { tenantId: "" }, { tenantId: 5 }, { tenantId: { id: "T-1" } }, { siteId: "S-1" }, [], null];

    for (const payload of payloads) forwardEvent(asServer(), "iot:event:changed", JSON.stringify(payload));

    expect(to).not.toHaveBeenCalled();
  });

  test("ignores channels it did not subscribe to, including inherited object keys", () => {
    const { to, asServer } = fakeIo();
    const raw = JSON.stringify({ tenantId: "T-1" });

    forwardEvent(asServer(), "other:channel", raw);
    forwardEvent(asServer(), "toString", raw);

    expect(to).not.toHaveBeenCalled();
  });

  test("logs invalid JSON without throwing", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { to, asServer } = fakeIo();

    expect(() => forwardEvent(asServer(), "iot:event:changed", "{not json")).not.toThrow();

    expect(to).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("[socket] Invalid event on iot:event:changed:", expect.any(String));
    error.mockRestore();
  });
});

describe("attaching the socket server", () => {
  const originalCors = process.env.CORS_ORIGIN;
  const io = { use: jest.fn(), on: jest.fn(), adapter: jest.fn(), to: jest.fn() };
  const httpServer = { on: jest.fn() };
  let pub: ReturnType<typeof fakeRedis>;
  let sub: ReturnType<typeof fakeRedis>;
  let events: ReturnType<typeof fakeRedis>;

  // Builds an ioredis double.
  function fakeRedis() {
    return {
      on: jest.fn(),
      duplicate: jest.fn(),
      subscribe: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue("OK")
    };
  }

  const attach = (): RealtimeServer | null => attachSocketServer(httpServer as unknown as HttpServer);

  beforeEach(() => {
    Object.assign(env, { REDIS_URL: "redis://localhost:6379", JWT_PUBLIC_KEY: "public-key" });
    delete process.env.CORS_ORIGIN;
    pub = fakeRedis();
    sub = fakeRedis();
    events = fakeRedis();
    pub.duplicate.mockReturnValueOnce(sub).mockReturnValueOnce(events);
    RedisMock.mockImplementation(() => pub);
    ServerMock.mockImplementation(() => io);
    createAdapterMock.mockReturnValue("redis-adapter");
  });

  afterEach(() => {
    Object.assign(env, { REDIS_URL: undefined, JWT_PUBLIC_KEY: undefined });
    if (originalCors === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalCors;
  });

  test("does nothing without Redis or a public key", () => {
    Object.assign(env, { REDIS_URL: undefined });
    expect(attach()).toBeNull();
    Object.assign(env, { REDIS_URL: "redis://localhost:6379", JWT_PUBLIC_KEY: undefined });
    expect(attach()).toBeNull();
    expect(ServerMock).not.toHaveBeenCalled();
    expect(RedisMock).not.toHaveBeenCalled();
  });

  test("creates the server with the allowed origins and registers its handlers", () => {
    process.env.CORS_ORIGIN = "https://a.example.test,https://b.example.test";

    expect(attach()).toBe(io);

    expect(ServerMock).toHaveBeenCalledWith(httpServer, {
      cors: { origin: ["https://a.example.test", "https://b.example.test"], credentials: true },
      transports: ["websocket", "polling"]
    });
    expect(io.use).toHaveBeenCalledWith(authenticateSocket);
    expect(io.on).toHaveBeenCalledWith("connection", handleConnection);
  });

  test("allows no cross-origin clients when CORS_ORIGIN is not set", () => {
    attach();

    expect(callArgs(ServerMock)[1]).toEqual(expect.objectContaining({ cors: { origin: [], credentials: true } }));
  });

  test("scales through the Redis adapter and subscribes on its own connection", () => {
    attach();

    expect(RedisMock).toHaveBeenCalledWith("redis://localhost:6379");
    expect(createAdapterMock).toHaveBeenCalledWith(pub, sub);
    expect(io.adapter).toHaveBeenCalledWith("redis-adapter");
    expect(events.subscribe).toHaveBeenCalledWith("ai:classification:completed", "iot:event:changed");
  });

  test("forwards messages from the subscriber connection to the rooms", () => {
    const emit = jest.fn();
    io.to.mockReturnValue({ emit });
    attach();
    const message = events.on.mock.calls.find((call) => call[0] === "message");
    const handler = message?.[1] as (channel: string, raw: string) => void;

    handler("iot:event:changed", JSON.stringify({ tenantId: "T-1" }));

    expect(io.to).toHaveBeenCalledWith("tenant:T-1");
    expect(emit).toHaveBeenCalledWith("iot:event:changed", { tenantId: "T-1" });
  });

  test("logs Redis connection errors and a failed subscribe", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    events.subscribe.mockRejectedValue(new Error("no permission"));
    attach();

    const [, onError] = callArgs(pub.on) as [string, (e: Error) => void];
    onError(new Error("ECONNRESET"));
    await flushPromises();

    expect(error).toHaveBeenCalledWith("[socket] Redis error:", "ECONNRESET");
    expect(error).toHaveBeenCalledWith("[socket] Redis subscribe failed:", "no permission");
    error.mockRestore();
  });

  test("closes all three Redis connections when the HTTP server closes", async () => {
    attach();
    const close = httpServer.on.mock.calls.find((call) => call[0] === "close");
    (close?.[1] as () => void)();
    await flushPromises();

    expect(pub.quit).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);
    expect(events.quit).toHaveBeenCalledTimes(1);
  });
});
