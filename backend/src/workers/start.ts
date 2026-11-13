import "dotenv/config";
import { env } from "../config/env";
import { connectMongo, mongoose } from "../db/mongo";
import { disconnectPostgres, getPrisma } from "../db/postgres";
import { closeRedis, getRedis } from "../db/redis";
import { closeDeadLetterQueue } from "../queues/deadLetterQueue";
import { closeRoutingQueue } from "../queues/routingQueue";
import { errorMessage } from "../utils/errors";
import { startAiWorker } from "./aiWorker";
import { startRoutingWorker } from "./routingWorker";

// Connects the databases and starts both workers.
export async function start(): Promise<void> {
  if (!env.MONGODB_URI || !env.DATABASE_URL || !env.REDIS_URL) {
    throw new Error("Worker requires MONGODB_URI, DATABASE_URL and REDIS_URL");
  }
  await connectMongo();
  await getPrisma().$connect();
  if (getRedis().status === "wait") await getRedis().connect();

  const aiWorker = startAiWorker();
  const routingWorker = startRoutingWorker();

  routingWorker.on("completed", (job, result) =>
    console.log(`[routing-worker] job ${job.id}: ${result.delivered ? "delivered" : result.reason}`)
  );
  routingWorker.on("failed", (job, error) => console.error(`[routing-worker] failed ${job?.id}:`, error.message));
  aiWorker.on("completed", (job) => console.log(`[worker] completed ${job.id}`));
  aiWorker.on("failed", (job, error) => console.error(`[worker] failed ${job?.id}:`, error.message));

  let closing = false;

  // Closes workers, queues and databases on exit.
  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    console.log(`[worker] ${signal} received; shutting down`);
    try {
      await Promise.all([aiWorker.close(), routingWorker.close()]);
      await Promise.all([closeRoutingQueue(), closeDeadLetterQueue()]);
      await Promise.allSettled([disconnectPostgres(), closeRedis(), mongoose.disconnect()]);
      process.exit(0);
    } catch (error) {
      console.error("[worker] shutdown failed:", errorMessage(error));
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  console.log("[worker] AI decision worker started");
}

if (require.main === module) {
  start().catch((error: unknown) => {
    console.error("[worker] startup failed:", errorMessage(error));
    process.exit(1);
  });
}
