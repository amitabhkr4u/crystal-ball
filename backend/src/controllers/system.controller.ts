import type { Request, Response } from "express";
import { approvals } from "../data/approvals";
import { sendError } from "../utils/httpResponse";
import { env } from "../config/env";
import { mongoose } from "../db/mongo";
import { getRedis } from "../db/redis";
import { getPrisma } from "../db/postgres";

// Reports that the API is up and which services are configured.
export function health(_req: Request, res: Response): Response {
  return res.json({
    ok: true,
    service: "crystal-ball-api",
    timestamp: new Date().toISOString(),
    capabilities: {
      mongo: Boolean(process.env.MONGODB_URI),
      postgres: Boolean(process.env.DATABASE_URL),
      mysql: Boolean(process.env.MYSQL_HOST),
      redis: Boolean(process.env.REDIS_URL),
      objectStorage: Boolean(process.env.S3_BUCKET),
      malwareScanner: Boolean(process.env.CLAMAV_HOST),
      onCallDelivery: Boolean(process.env.ONCALL_WEBHOOK_URL)
    }
  });
}

// Returns one page of the demo approvals list.
export function listApprovals(req: Request, res: Response): Response {
  const page = Number.parseInt(String(req.query.page || "1"), 10);
  const limit = Number.parseInt(String(req.query.limit || "20"), 10);

  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return sendError(res, 400, "VALIDATION_ERROR", "page must be >= 1 and limit must be between 1 and 100");
  }

  const total = approvals.length;
  const items = approvals.slice((page - 1) * limit, page * limit);
  return res.json({
    approvals: items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
}

// Confirms that configured runtime dependencies can serve requests.
export async function ready(_req: Request, res: Response): Promise<Response> {
  const checks: Record<string, boolean> = {};
  if (env.MONGODB_URI) checks.mongo = mongoose.connection.readyState === 1;
  if (env.REDIS_URL) {
    try {
      checks.redis = (await getRedis().ping()) === "PONG";
    } catch {
      checks.redis = false;
    }
  }
  if (env.DATABASE_URL) {
    try {
      await getPrisma().$queryRaw`SELECT 1`;
      checks.postgres = true;
    } catch {
      checks.postgres = false;
    }
  }
  const ready = Object.values(checks).every(Boolean);
  return res.status(ready ? 200 : 503).json({
    ok: ready,
    service: "crystal-ball-api",
    checks,
    timestamp: new Date().toISOString()
  });
}
