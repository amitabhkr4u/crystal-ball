import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/authorize";
import { redisRateLimit } from "../middleware/redisRateLimit";
import { requireTenant } from "../middleware/tenantScope";
import { ingestMaintenanceDocument } from "../rag/maintenanceIngest.service";
import { errorMessage } from "../utils/errors";
import { sendError } from "../utils/httpResponse";
import { getTenantId } from "../utils/requestContext";

export const maintenanceRoutes: Router = Router();
const schema = z.object({
  documentId: z.string().trim().min(1).max(180),
  text: z.string().trim().min(20).max(240000),
  metadata: z.record(z.unknown()).optional().default({})
});

// Chunks, embeds and stores a maintenance document for search.
maintenanceRoutes.post(
  "/index",
  authenticate,
  requireTenant,
  requireRole("admin", "safety_lead"),
  redisRateLimit({ max: 10, windowMs: 60000, prefix: "rate:maintenance-index" }),
  async (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, "VALIDATION_ERROR", "Invalid maintenance document payload", parsed.error.issues);
    }
    try {
      const result = await ingestMaintenanceDocument({ tenantId: getTenantId(req), ...parsed.data });
      return res.status(201).json({ data: result });
    } catch (error) {
      const message = errorMessage(error);
      if (message === "EMBEDDINGS_API_KEY is not configured") {
        return sendError(res, 503, "EMBEDDINGS_NOT_CONFIGURED", message);
      }
      return next(error);
    }
  }
);
