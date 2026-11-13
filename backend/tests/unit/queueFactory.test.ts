import { Queue } from "bullmq";
import { createQueueHolder } from "../../src/queues/queueFactory";

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ close: jest.fn().mockResolvedValue(undefined) }))
}));
jest.mock("../../src/db/redis", () => ({ getRedis: jest.fn(() => "redis-connection") }));

const QueueMock = Queue as unknown as jest.Mock;
const jobOptions = { attempts: 3 };

describe("createQueueHolder", () => {
  test("does not touch BullMQ until the queue is first requested", () => {
    createQueueHolder("jobs", jobOptions);
    expect(QueueMock).not.toHaveBeenCalled();
  });

  test("creates one queue with the shared Redis connection and reuses it", () => {
    const holder = createQueueHolder("jobs", jobOptions);
    const first = holder.get();
    expect(holder.get()).toBe(first);
    expect(QueueMock).toHaveBeenCalledTimes(1);
    expect(QueueMock).toHaveBeenCalledWith("jobs", { connection: "redis-connection", defaultJobOptions: jobOptions });
  });

  test("close is a no-op before the queue was opened", async () => {
    const holder = createQueueHolder("jobs", jobOptions);
    await expect(holder.close()).resolves.toBeUndefined();
    expect(QueueMock).not.toHaveBeenCalled();
  });

  test("close shuts the queue down and the next get builds a new one", async () => {
    const holder = createQueueHolder("jobs", jobOptions);
    const first = holder.get();
    await holder.close();
    expect((first as unknown as { close: jest.Mock }).close).toHaveBeenCalledTimes(1);
    expect(holder.get()).not.toBe(first);
    expect(QueueMock).toHaveBeenCalledTimes(2);
  });

  test("a failed close still clears the holder so a half-closed queue is not reused", async () => {
    const holder = createQueueHolder("jobs", jobOptions);
    const first = holder.get() as unknown as { close: jest.Mock };
    first.close.mockRejectedValueOnce(new Error("redis gone"));
    await expect(holder.close()).rejects.toThrow("redis gone");
    expect(holder.get()).not.toBe(first);
  });
});
