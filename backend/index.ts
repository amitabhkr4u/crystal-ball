import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { openApi } from "./src/config/openapi";
import { connectMongo, mongoose } from "./src/db/mongo";
import { watchIoTEvents } from "./src/db/mongoChangeStream";
import { closeMysql, getMysqlReadPool } from "./src/db/mysql";
import { disconnectPostgres, getPrisma } from "./src/db/postgres";
import { closeRedis, getRedis } from "./src/db/redis";
import { errorHandler } from "./src/middleware/errorHandler";
import { IoTEvent } from "./src/models/IoTEvent";
import { LlmUsage } from "./src/models/LlmUsage";
import { register as metricsRegistry } from "./src/observability/metrics";
import { closeAiQueue } from "./src/queues/aiQueue";
import { closeDeadLetterQueue } from "./src/queues/deadLetterQueue";
import { closeRoutingQueue } from "./src/queues/routingQueue";
import { routes } from "./src/routes";
import { attachSocketServer } from "./src/sockets";
import { errorMessage } from "./src/utils/errors";
import { sendError } from "./src/utils/httpResponse";

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT) || 4000;
const socketServer = attachSocketServer(server);
let mongoChangeStream: ReturnType<typeof watchIoTEvents> | undefined;

const REQUIRED_IN_PRODUCTION = [
  "MONGODB_URI",
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "CORS_ORIGIN",
  "CLAMAV_HOST",
  "ONCALL_WEBHOOK_URL",
  "AWS_REGION",
  "S3_BUCKET",
  "METRICS_TOKEN"
] as const;

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "http://localhost:3000",
    credentials: true
  })
);

// Gives every request an id and returns it in a header.
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
});
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());

// Serves Prometheus metrics, protected by METRICS_TOKEN.
app.get("/metrics", async (req, res, next) => {
  try {
    const token = process.env.METRICS_TOKEN;
    if (process.env.NODE_ENV === "production" && !token) return res.sendStatus(404);
    if (token && req.get("authorization") !== `Bearer ${token}`) return res.sendStatus(401);
    res.set("Content-Type", metricsRegistry.contentType);
    return res.end(await metricsRegistry.metrics());
  } catch (error) {
    return next(error);
  }
});

app.use(routes);
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApi, { customSiteTitle: "Crystal Ball API docs" }));
app.use((_req, res) => sendError(res, 404, "NOT_FOUND", "Route not found."));
app.use(errorHandler);

// Stops startup early if a production setting is missing.
function assertProductionConfig(): void {
  const missing = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  const webhookUrl = process.env.ONCALL_WEBHOOK_URL;
  if (webhookUrl && new URL(webhookUrl).protocol !== "https:") {
    throw new Error("ONCALL_WEBHOOK_URL must use HTTPS in production");
  }
}

// Connects MongoDB, creates indexes and starts the change stream.
async function connectMongoDb(): Promise<void> {
  await connectMongo();
  await Promise.all([IoTEvent.createIndexes(), LlmUsage.createIndexes()]);
  console.info("[database] MongoDB connected; IoT indexes are ready.");
  if (process.env.NODE_ENV === "production" || process.env.MONGO_CHANGE_STREAMS_ENABLED === "true") {
    mongoChangeStream = watchIoTEvents();
  }
}

// Checks that PostgreSQL, Redis and optional MySQL are reachable.
async function connectProductionServices(): Promise<void> {
  await getPrisma().$connect();
  const redis = getRedis();
  if (redis.status === "wait") await redis.connect();
  if (process.env.MYSQL_HOST) {
    const connection = await getMysqlReadPool().getConnection();
    connection.release();
  }
  console.info("[database] PostgreSQL, Redis and MySQL checks passed.");
}

// Starts the HTTP server after connecting the databases.
async function start(): Promise<void> {
  try {
    if (process.env.NODE_ENV === "production") assertProductionConfig();
    if (process.env.MONGODB_URI) await connectMongoDb();
    if (process.env.NODE_ENV === "production") await connectProductionServices();
  } catch (error) {
    console.error("[startup] Dependency initialization failed:", errorMessage(error));
    if (process.env.NODE_ENV === "production") process.exit(1);
  }

  server.listen(port, () => console.info(`[api] Listening on http://localhost:${port}`));
}

// Closes the server, queues and databases on exit.
async function shutdown(signal: string): Promise<void> {
  console.info(`[api] ${signal} received. Shutting down gracefully.`);
  if (socketServer) socketServer.disconnectSockets(true);

  server.close(async () => {
    try {
      if (mongoChangeStream) await mongoChangeStream.close();
      await closeAiQueue();
      await closeRoutingQueue();
      await closeDeadLetterQueue();
      await disconnectPostgres();
      await closeMysql();
      await closeRedis();
      if (mongoose.connection.readyState) await mongoose.disconnect();
    } catch (error) {
      console.error("[api] Shutdown error:", errorMessage(error));
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

if (require.main === module) void start();

export { app, server, start, shutdown };
