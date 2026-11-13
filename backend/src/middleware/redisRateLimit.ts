import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getRedis } from "../db/redis";
import { sendError } from "../utils/httpResponse";

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  prefix?: string;
}

// Builds a fixed-window rate limiter backed by Redis.
export function redisRateLimit({ windowMs = 60_000, max = 20, prefix = "rate:ai" }: RateLimitOptions = {}): RequestHandler {
  // Counts requests per IP and user, and blocks when over the limit.
  return async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const bucket = Math.floor(Date.now() / windowMs);
      const keys = [`${prefix}:ip:${req.ip}:${bucket}`];
      const identity = req.auth?.sub || req.get("X-Session-Id");
      if (identity) keys.push(`${prefix}:identity:${identity}:${bucket}`);

      const redis = getRedis();
      const counts = await Promise.all(
        keys.map(async (key) => {
          const count = await redis.incr(key);
          if (count === 1) await redis.expire(key, Math.ceil(windowMs / 1000) + 1);
          return count;
        })
      );
      const count = Math.max(...counts);

      res.setHeader("RateLimit-Limit", String(max));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, max - count)));
      if (count > max) {
        sendError(res, 429, "RATE_LIMITED", "Too many requests. Please wait before retrying.");
        return;
      }
    } catch {
      // Fail open outside production so local work does not need Redis.
      if (process.env.NODE_ENV === "production") {
        sendError(res, 503, "RATE_LIMIT_UNAVAILABLE", "Request protection is temporarily unavailable.");
        return;
      }
    }
    next();
  };
}
