import { UnrecoverableError, Worker } from "bullmq";
import { env } from "../../src/config/env";
import { getRedis } from "../../src/db/redis";
import { IoTEvent } from "../../src/models/IoTEvent";
import { getRoutingQueue } from "../../src/queues/routingQueue";
import { searchMaintenanceChunks } from "../../src/rag/maintenanceSearch.service";
import { classifyAlert } from "../../src/services/aiDecision.service";
import { createEmbedding } from "../../src/services/embedding.service";
import { hashId } from "../../src/utils/hash";
import { processAlertJob, startAiWorker, type AlertJob } from "../../src/workers/aiWorker";
import { callArgs } from "../helpers/mocks";

jest.mock("bullmq", () => ({
  Worker: jest.fn(),
  UnrecoverableError: class UnrecoverableError extends Error {}
}));
jest.mock("../../src/db/redis", () => ({ getRedis: jest.fn() }));
jest.mock("../../src/models/IoTEvent", () => ({ IoTEvent: { find: jest.fn(), updateOne: jest.fn() } }));
jest.mock("../../src/queues/routingQueue", () => ({ getRoutingQueue: jest.fn() }));
jest.mock("../../src/rag/maintenanceSearch.service", () => ({ searchMaintenanceChunks: jest.fn() }));
jest.mock("../../src/services/aiDecision.service", () => ({ classifyAlert: jest.fn() }));
jest.mock("../../src/services/embedding.service", () => ({ createEmbedding: jest.fn() }));

const WorkerMock = Worker as unknown as jest.Mock;
const getRedisMock = getRedis as unknown as jest.Mock;
const getRoutingQueueMock = getRoutingQueue as unknown as jest.Mock;
const findMock = IoTEvent.find as unknown as jest.Mock;
const updateOneMock = IoTEvent.updateOne as unknown as jest.Mock;
const searchMock = searchMaintenanceChunks as unknown as jest.Mock;
const classifyMock = classifyAlert as unknown as jest.Mock;
const embeddingMock = createEmbedding as unknown as jest.Mock;

const alertData = {
  tenantId: "T-1",
  alertId: "A-1",
  siteId: "S-1",
  sensorId: "SN-1",
  severity: "P0",
  occurredAt: "2026-11-13T10:00:00.000Z",
  payload: { smokeLevel: 0.9 }
};

const classification = {
  severity: "P0",
  likelyRootCause: "Smoke detected near the loading bay",
  urgency: "immediate",
  confidence: 0.9,
  operatorSummary: "Smoke sensor SN-1 triggered at site S-1",
  recommendedChecks: ["Confirm on site"],
  requiresHumanConfirmation: true,
  fallback: false,
  promptVersion: "v1"
};

const historyDocs = [{ sensorId: "SN-1", severity: "P1" }];

// Builds the part of a BullMQ job the worker reads.
function alertJob(data: unknown = alertData, name = "classify-alert"): AlertJob {
  return { name, data } as unknown as AlertJob;
}

describe("AI classification worker", () => {
  const redis = { publish: jest.fn() };
  let addRoute: jest.Mock;
  let sort: jest.Mock;
  let limit: jest.Mock;

  beforeEach(() => {
    addRoute = jest.fn().mockResolvedValue({ id: "route-job" });
    redis.publish.mockResolvedValue(1);
    getRoutingQueueMock.mockReturnValue({ add: addRoute });
    getRedisMock.mockReturnValue(redis);

    const lean = jest.fn().mockResolvedValue(historyDocs);
    limit = jest.fn().mockReturnValue({ lean });
    sort = jest.fn().mockReturnValue({ limit });
    findMock.mockReturnValue({ sort });
    updateOneMock.mockResolvedValue({});

    embeddingMock.mockResolvedValue([0.1, 0.2]);
    searchMock.mockResolvedValue([{ id: "chunk-1" }]);
    classifyMock.mockResolvedValue(classification);
  });

  test("classifies the alert, routes it, saves the result and tells operators", async () => {
    const result = await processAlertJob(alertJob());

    expect(findMock).toHaveBeenCalledWith({ tenantId: "T-1", siteId: "S-1", sensorId: "SN-1" });
    expect(sort).toHaveBeenCalledWith({ occurredAt: -1 });
    expect(limit).toHaveBeenCalledWith(12);
    expect(searchMock).toHaveBeenCalledWith({ tenantId: "T-1", embedding: [0.1, 0.2], limit: 5 });
    expect(classifyMock).toHaveBeenCalledWith({
      alert: expect.objectContaining(alertData),
      history: historyDocs,
      retrievedDocs: [{ id: "chunk-1" }]
    });

    expect(result.routing).toEqual(
      expect.objectContaining({ destination: "on_call", priority: 1, physicalActionTriggered: false })
    );
    expect(result).toEqual(expect.objectContaining({ alertId: "A-1", siteId: "S-1", tenantId: "T-1" }));

    expect(addRoute).toHaveBeenCalledWith(
      "operator-routing",
      {
        tenantId: "T-1",
        alertId: "A-1",
        siteId: "S-1",
        severity: "P0",
        routing: result.routing,
        operatorSummary: classification.operatorSummary
      },
      { jobId: hashId("T-1", "A-1", "route"), priority: 1 }
    );
    expect(updateOneMock).toHaveBeenCalledWith(
      { tenantId: "T-1", dedupeKey: "T-1:A-1" },
      { $set: { classification: result } }
    );
    const [channel, message] = callArgs(redis.publish);
    expect(channel).toBe("ai:classification:completed");
    expect(JSON.parse(String(message))).toEqual(JSON.parse(JSON.stringify(result)));
  });

  test("still classifies when document retrieval fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    embeddingMock.mockRejectedValue(new Error("embeddings down"));

    await processAlertJob(alertJob());

    expect(searchMock).not.toHaveBeenCalled();
    expect(classifyMock).toHaveBeenCalledWith(expect.objectContaining({ retrievedDocs: [] }));
    expect(warn).toHaveBeenCalledWith("[worker] RAG retrieval skipped:", "embeddings down");
    warn.mockRestore();
  });

  test("skips the document search when no embedding is available", async () => {
    embeddingMock.mockResolvedValue(null);

    await processAlertJob(alertJob());

    expect(searchMock).not.toHaveBeenCalled();
    expect(classifyMock).toHaveBeenCalledWith(expect.objectContaining({ retrievedDocs: [] }));
  });

  test("rejects other job names without retrying and without touching the database", async () => {
    const attempt = processAlertJob(alertJob(alertData, "something-else"));

    await expect(attempt).rejects.toThrow("Unsupported AI job: something-else");
    await expect(attempt).rejects.toBeInstanceOf(UnrecoverableError);
    expect(findMock).not.toHaveBeenCalled();
  });

  test("rejects jobs without a full tenant scope before any query runs", async () => {
    const { tenantId: _tenantId, ...withoutTenant } = alertData;

    await expect(processAlertJob(alertJob(withoutTenant))).rejects.toThrow("Invalid AI job data: tenantId");
    await expect(processAlertJob(alertJob({ ...alertData, siteId: "" }))).rejects.toThrow(
      "Invalid AI job data: siteId"
    );
    await expect(processAlertJob(alertJob({ ...alertData, sensorId: 42 }))).rejects.toBeInstanceOf(
      UnrecoverableError
    );
    expect(findMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
  });

  test("lets a failed save fail the job so BullMQ can retry it", async () => {
    updateOneMock.mockRejectedValue(new Error("mongo down"));

    await expect(processAlertJob(alertJob())).rejects.toThrow("mongo down");
    expect(redis.publish).not.toHaveBeenCalled();
  });

  test("starts a BullMQ worker on the AI queue", () => {
    const worker = { on: jest.fn() };
    WorkerMock.mockImplementation(() => worker);

    expect(startAiWorker()).toBe(worker);
    expect(WorkerMock).toHaveBeenCalledWith(env.AI_QUEUE_NAME, processAlertJob, {
      connection: redis,
      concurrency: 5
    });
  });
});
