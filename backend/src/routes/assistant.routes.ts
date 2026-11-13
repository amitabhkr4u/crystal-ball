import { Router } from "express";
import { streamAssistant } from "../controllers/assistant.controller";
import { redisRateLimit } from "../middleware/redisRateLimit";

export const assistantRoutes: Router = Router();

assistantRoutes.use(
  redisRateLimit({
    max: Number(process.env.RATE_LIMIT_MAX) || 20,
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000
  })
);

// Streams an assistant answer for summary, talk, help, teach or greeting.
// The controller answers 404 for any other :path.
assistantRoutes.post("/:path", streamAssistant);
