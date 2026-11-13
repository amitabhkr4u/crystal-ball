import Redis from "ioredis";
import { env } from "../config/env";

let redis: Redis | undefined;

// Returns the shared lazy Redis client.
export function getRedis(): Redis {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is required for distributed runtime features");
  if (!redis) {
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true
    });
  }
  return redis;
}

// Closes the Redis connection and clears the shared client.
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = undefined;
  }
}
