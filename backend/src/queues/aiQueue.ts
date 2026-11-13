import { env } from "../config/env";
import type { AlertJobData } from "../types/alert";
import { createQueueHolder } from "./queueFactory";

const holder = createQueueHolder<AlertJobData>(env.AI_QUEUE_NAME, {
  attempts: 2,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800 }
});

export const getAiQueue = holder.get;
export const closeAiQueue = holder.close;
