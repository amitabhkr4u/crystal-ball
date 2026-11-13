import { Router } from "express";
import { mongoose } from "../db/mongo";
import { authenticate } from "../middleware/authenticate";
import { requireTenant } from "../middleware/tenantScope";
import { getDailyLlmUsage } from "../services/llmCost.service";
import { getTenantId } from "../utils/requestContext";
import { sendError } from "../utils/httpResponse";

export const usageRoutes: Router = Router();

usageRoutes.get("/llm/daily", authenticate, requireTenant, async (req, res, next) => {
  if (mongoose.connection.readyState !== 1) return sendError(res, 503, "USAGE_UNAVAILABLE", "LLM usage storage is unavailable");
  try {
    return res.json({ data: await getDailyLlmUsage(getTenantId(req)) });
  } catch (error) {
    return next(error);
  }
});
