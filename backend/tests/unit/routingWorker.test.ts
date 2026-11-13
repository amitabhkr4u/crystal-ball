import { Worker, type Job } from "bullmq";
import { env } from "../../src/config/env";
import { getRedis } from "../../src/db/redis";
import { getDeadLetterQueue } from "../../src/queues/deadLetterQueue";
import { routeClassification } from "../../src/services/decisionRouter.service";
import type { RoutingJobData } from "../../src/types/routing";
import {
  deliverOnCall,
  moveToDeadLetter,
  startRoutingWorker,
  type DeliveryResult,
  type RoutingJob
} from "../../src/workers/routingWorker";
import { callArgs, flushPromises } from "../helpers/mocks";

jest.mock("bullmq", () => ({ Worker: jest.fn() }));
jest.mock("../../src/db/redis", () => ({ getRedis: jest.fn() }));
jest.mock("../../src/queues/deadLetterQueue", () => ({ getDeadLetterQueue: jest.fn() }));

const WorkerMock = Worker as unknown as jest.Mock;
const getRedisMock = getRedis as unknown as jest.Mock;
const getDeadLetterQueueMock = getDeadLetterQueue as unknown as jest.Mock;

const SETTINGS = ["NODE_ENV", "ONCALL_WEBHOOK_URL", "ONCALL_WEBHOOK_TOKEN", "ONCALL_TIMEOUT_MS"] as const;

const baseData: RoutingJobData = {
  tenantId: "T-1",
  alertId: "A-1",
  siteId: "S-1",
  severity: "P0",
  operatorSummary: "Smoke sensor alert",
  routing: routeClassification({ severity: "P0" })
};

// Builds the part of a BullMQ job the delivery reads.
function routingJob(data: Partial<RoutingJobData> = {}, id = "job-1"): RoutingJob {
  return { id, data: { ...baseData, ...data } };
}

// Builds a failed job that has used the given number of attempts.
function failedJob(attemptsMade: number, attempts = 3): Job<RoutingJobData, DeliveryResult> {
  return { id: "job-1", data: baseData, attemptsMade, opts: { attempts } } as unknown as Job<RoutingJobData, DeliveryResult>;
}

describe("on-call routing delivery", () => {
  const originalFetch = global.fetch;
  const saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
  let fetchMock: jest.Mock;

  // Sets or removes one process.env value.
  function setEnv(name: (typeof SETTINGS)[number], value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    global.fetch = fetchMock as unknown as typeof fetch;
    setEnv("NODE_ENV", "test");
    setEnv("ONCALL_WEBHOOK_URL", "https://oncall.example.test/events");
    setEnv("ONCALL_WEBHOOK_TOKEN", undefined);
    setEnv("ONCALL_TIMEOUT_MS", undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    SETTINGS.forEach((name) => setEnv(name, saved[name]));
  });

  test("sends idempotent operator notification and never triggers physical action", async () => {
    const result = await deliverOnCall(routingJob());

    expect(result).toEqual({ delivered: true, status: 202 });
    const [url, request] = callArgs(fetchMock) as [URL, { headers: Record<string, string>; body: string; signal: unknown }];
    expect(String(url)).toBe("https://oncall.example.test/events");
    expect(request.headers["idempotency-key"]).toBe("job-1");
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toEqual(
      expect.objectContaining({
        event: "crystal-ball.alert.routed",
        alertId: "A-1",
        tenantId: "T-1",
        siteId: "S-1",
        severity: "P0",
        summary: "Smoke sensor alert",
        humanOverride: null,
        requiresHumanConfirmation: true,
        physicalActionTriggered: false
      })
    );
  });

  test("sends the bearer token and the human override when present", async () => {
    setEnv("ONCALL_WEBHOOK_TOKEN", "secret-token");
    const humanOverride = { by: "U-1", reason: "Confirmed false alarm", at: "2026-11-13T10:00:00.000Z" };

    await deliverOnCall(routingJob({ humanOverride }));

    const [, request] = callArgs(fetchMock) as [URL, { headers: Record<string, string>; body: string }];
    expect(request.headers["authorization"]).toBe("Bearer secret-token");
    expect((JSON.parse(request.body) as { humanOverride: unknown }).humanOverride).toEqual(humanOverride);
  });

  test("rejects non-HTTPS production webhook endpoints", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("ONCALL_WEBHOOK_URL", "http://oncall.example.test/events");

    await expect(deliverOnCall(routingJob({}, "job-2"))).rejects.toThrow("HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reports not_configured outside production when no webhook is set", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    setEnv("ONCALL_WEBHOOK_URL", undefined);

    await expect(deliverOnCall(routingJob())).resolves.toEqual({ delivered: false, reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("fails in production when no webhook is set", async () => {
    setEnv("NODE_ENV", "production");
    setEnv("ONCALL_WEBHOOK_URL", undefined);

    await expect(deliverOnCall(routingJob())).rejects.toThrow("ONCALL_WEBHOOK_URL is required in production");
  });

  test("fails the job when the provider answers with an error status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(deliverOnCall(routingJob())).rejects.toThrow("On-call provider returned HTTP 503");
  });
});

describe("dead-letter handling", () => {
  const add = jest.fn();

  beforeEach(() => {
    add.mockResolvedValue({});
    getDeadLetterQueueMock.mockReturnValue({ add });
  });

  test("keeps a job that ran out of attempts, with its payload and failure", async () => {
    await moveToDeadLetter(failedJob(3), new Error("provider down"));

    const [name, data, options] = callArgs(add) as [string, Record<string, unknown>, unknown];
    expect(name).toBe("routing-delivery-failed");
    expect(data).toEqual(
      expect.objectContaining({ originalJobId: "job-1", payload: baseData, failure: "provider down" })
    );
    expect(options).toEqual({ jobId: "dead-job-1" });
  });

  test("ignores failures that will still be retried or have no job", async () => {
    await moveToDeadLetter(failedJob(1), new Error("provider down"));
    await moveToDeadLetter(undefined, new Error("stalled"));

    expect(add).not.toHaveBeenCalled();
  });

  test("treats a job without an attempts option as a single attempt", async () => {
    const job = { id: "job-1", data: baseData, attemptsMade: 1, opts: {} } as unknown as Job<RoutingJobData, DeliveryResult>;

    await moveToDeadLetter(job, new Error("provider down"));

    expect(add).toHaveBeenCalledTimes(1);
  });

  test("does not throw when the dead-letter queue itself fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    add.mockRejectedValue(new Error("redis down"));

    await expect(moveToDeadLetter(failedJob(3), new Error("provider down"))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("[routing-worker] failed to persist dead-letter job:", "redis down");
    error.mockRestore();
  });
});

describe("routing worker", () => {
  const redis = { name: "redis" };
  const add = jest.fn();

  beforeEach(() => {
    add.mockResolvedValue({});
    getRedisMock.mockReturnValue(redis);
    getDeadLetterQueueMock.mockReturnValue({ add });
  });

  test("starts a BullMQ worker on the routing queue", () => {
    const worker = { on: jest.fn() };
    WorkerMock.mockImplementation(() => worker);

    expect(startRoutingWorker()).toBe(worker);
    expect(WorkerMock).toHaveBeenCalledWith("operator-routing", deliverOnCall, {
      connection: redis,
      concurrency: env.ROUTING_WORKER_CONCURRENCY
    });
  });

  test("sends jobs that failed for good to the dead-letter queue", async () => {
    const worker = { on: jest.fn() };
    WorkerMock.mockImplementation(() => worker);
    startRoutingWorker();

    const [event, handler] = callArgs(worker.on) as [string, (job: unknown, error: Error) => void];
    expect(event).toBe("failed");
    handler(failedJob(3), new Error("provider down"));
    await flushPromises();

    expect(add).toHaveBeenCalledTimes(1);
  });
});
