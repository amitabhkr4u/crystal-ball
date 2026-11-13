import type { DeadLetterJobData } from "../types/routing";
import { createQueueHolder } from "./queueFactory";

const holder = createQueueHolder<DeadLetterJobData>("operator-routing-dead-letter", {
  removeOnComplete: false,
  removeOnFail: false
});

export const getDeadLetterQueue = holder.get;
export const closeDeadLetterQueue = holder.close;
