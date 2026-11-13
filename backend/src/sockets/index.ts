import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { verifyAccessToken, type AccessClaims } from "../auth/tokens";
import { env } from "../config/env";
import { errorMessage } from "../utils/errors";

const SITE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

// Redis channel -> the Socket.IO event sent to the whole tenant and to one site room.
const CHANNELS = {
  "ai:classification:completed": { tenantEvent: "ai:classification:completed", siteEvent: "site:alert:classified" },
  "iot:event:changed": { tenantEvent: "iot:event:changed", siteEvent: "site:iot:event" }
} as const;

type Channel = keyof typeof CHANNELS;
type RealtimeEventName = (typeof CHANNELS)[Channel][keyof (typeof CHANNELS)[Channel]];

// What every Redis event must carry so it can be sent to the right room.
const realtimeEventSchema = z.object({ tenantId: z.string().min(1), siteId: z.string().optional() }).passthrough();

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export type ClientToServerEvents = { "site:subscribe": (siteId: unknown) => void };
export type ServerToClientEvents = Record<RealtimeEventName, (event: RealtimeEvent) => void>;
export type InterServerEvents = Record<string, never>;
export type SocketData = { auth: AccessClaims };

export type RealtimeServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type RealtimeSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

// True when the channel is one we subscribe to (own keys only, so "toString" is not a channel).
function isChannel(channel: string): channel is Channel {
  return Object.hasOwn(CHANNELS, channel);
}

// Rejects socket connections without a valid access token.
export function authenticateSocket(socket: RealtimeSocket, next: (error?: Error) => void): void {
  try {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== "string" || token === "") {
      next(new Error("UNAUTHORIZED"));
      return;
    }
    socket.data.auth = verifyAccessToken(token);
    next();
  } catch {
    next(new Error("UNAUTHORIZED"));
  }
}

// Puts a connected socket into its tenant room and site rooms.
export function handleConnection(socket: RealtimeSocket): void {
  const { tenantId } = socket.data.auth;
  void socket.join(`tenant:${tenantId}`);
  socket.on("site:subscribe", (siteId) => {
    if (typeof siteId === "string" && SITE_ID_PATTERN.test(siteId)) {
      void socket.join(`tenant:${tenantId}:site:${siteId}`);
    }
  });
}

// Sends a Redis event to the right tenant and site rooms.
export function forwardEvent(io: RealtimeServer, channel: string, raw: string): void {
  if (!isChannel(channel)) return;
  try {
    const parsed = realtimeEventSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const event = parsed.data;
    const names = CHANNELS[channel];
    io.to(`tenant:${event.tenantId}`).emit(names.tenantEvent, event);
    if (event.siteId) io.to(`tenant:${event.tenantId}:site:${event.siteId}`).emit(names.siteEvent, event);
  } catch (error) {
    console.error(`[socket] Invalid event on ${channel}:`, errorMessage(error));
  }
}

// Creates the Socket.IO server with Redis pub/sub for scaling.
export function attachSocketServer(httpServer: HttpServer): RealtimeServer | null {
  const { REDIS_URL, JWT_PUBLIC_KEY } = env;
  if (!REDIS_URL || !JWT_PUBLIC_KEY) return null;

  const io: RealtimeServer = new Server(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN?.split(",") || [], credentials: true },
    transports: ["websocket", "polling"]
  });
  io.use(authenticateSocket);
  io.on("connection", handleConnection);

  const pub = new Redis(REDIS_URL);
  const sub = pub.duplicate();
  const events = pub.duplicate();
  [pub, sub, events].forEach((connection) =>
    connection.on("error", (error: Error) => console.error("[socket] Redis error:", error.message))
  );

  io.adapter(createAdapter(pub, sub));
  events.subscribe(...Object.keys(CHANNELS)).catch((error: unknown) => {
    console.error("[socket] Redis subscribe failed:", errorMessage(error));
  });
  events.on("message", (channel: string, raw: string) => forwardEvent(io, channel, raw));
  httpServer.on("close", () => {
    void Promise.allSettled([pub.quit(), sub.quit(), events.quit()]);
  });
  return io;
}
