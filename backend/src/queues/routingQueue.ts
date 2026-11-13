import type { RoutingJobData } from "../types/routing";
import { createQueueHolder } from "./queueFactory";

export const ROUTING_QUEUE_NAME = "operator-routing";

const holder = createQueueHolder<RoutingJobData>(ROUTING_QUEUE_NAME, {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800 }
});

export const getRoutingQueue = holder.get;
export const closeRoutingQueue = holder.close;
