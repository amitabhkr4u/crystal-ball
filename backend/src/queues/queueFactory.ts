import { Queue, type DefaultJobOptions } from "bullmq";
import { getRedis } from "../db/redis";

export interface QueueHolder<TData> {
  get: () => Queue<TData>;
  close: () => Promise<void>;
}

// Creates a lazy BullMQ queue with get and close helpers.
export function createQueueHolder<TData = unknown>(
  name: string,
  defaultJobOptions: DefaultJobOptions
): QueueHolder<TData> {
  let queue: Queue<TData> | undefined;

  // Returns the shared queue, creating it on first use.
  function get(): Queue<TData> {
    if (!queue) queue = new Queue<TData>(name, { connection: getRedis(), defaultJobOptions });
    return queue;
  }

  // Closes the queue connection if it was opened.
  async function close(): Promise<void> {
    if (queue) {
      const closing = queue;
      queue = undefined;
      await closing.close();
    }
  }

  return { get, close };
}
