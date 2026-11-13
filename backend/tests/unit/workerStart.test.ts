import { env } from "../../src/config/env";
import { connectMongo, mongoose } from "../../src/db/mongo";
import { disconnectPostgres, getPrisma } from "../../src/db/postgres";
import { closeRedis, getRedis } from "../../src/db/redis";
import { closeDeadLetterQueue } from "../../src/queues/deadLetterQueue";
import { closeRoutingQueue } from "../../src/queues/routingQueue";
import { startAiWorker } from "../../src/workers/aiWorker";
import { startRoutingWorker } from "../../src/workers/routingWorker";
import { start } from "../../src/workers/start";
import { callArgs, flushPromises } from "../helpers/mocks";

jest.mock("../../src/config/env", () => ({ env: {} }));
jest.mock("../../src/db/mongo", () => ({ connectMongo: jest.fn(), mongoose: { disconnect: jest.fn() } }));
jest.mock("../../src/db/postgres", () => ({ getPrisma: jest.fn(), disconnectPostgres: jest.fn() }));
jest.mock("../../src/db/redis", () => ({ getRedis: jest.fn(), closeRedis: jest.fn() }));
jest.mock("../../src/queues/deadLetterQueue", () => ({ closeDeadLetterQueue: jest.fn() }));
jest.mock("../../src/queues/routingQueue", () => ({ closeRoutingQueue: jest.fn() }));
jest.mock("../../src/workers/aiWorker", () => ({ startAiWorker: jest.fn() }));
jest.mock("../../src/workers/routingWorker", () => ({ startRoutingWorker: jest.fn() }));

const REQUIRED = ["MONGODB_URI", "DATABASE_URL", "REDIS_URL"] as const;

const connectMongoMock = connectMongo as unknown as jest.Mock;
const getPrismaMock = getPrisma as unknown as jest.Mock;
const getRedisMock = getRedis as unknown as jest.Mock;
const startAiWorkerMock = startAiWorker as unknown as jest.Mock;
const startRoutingWorkerMock = startRoutingWorker as unknown as jest.Mock;
const mongooseDisconnectMock = mongoose.disconnect as unknown as jest.Mock;

describe("worker process", () => {
  const connectPrisma = jest.fn();
  const connectRedis = jest.fn();
  const redis = { status: "wait", connect: connectRedis };
  const aiWorker = { on: jest.fn(), close: jest.fn() };
  const routingWorker = { on: jest.fn(), close: jest.fn() };
  let processOn: jest.Mock;
  let processExit: jest.Mock;
  let log: jest.Mock;

  // Returns the listener the worker registered for one signal.
  function signalHandler(signal: string): () => void {
    const call = processOn.mock.calls.find((args) => args[0] === signal);
    if (!call) throw new Error(`No ${signal} handler registered`);
    return call[1] as () => void;
  }

  // Returns the listener a worker double got for one event.
  function workerHandler(worker: { on: jest.Mock }, event: string): (...args: unknown[]) => void {
    const call = worker.on.mock.calls.find((args) => args[0] === event);
    if (!call) throw new Error(`No ${event} handler registered`);
    return call[1] as (...args: unknown[]) => void;
  }

  beforeEach(() => {
    Object.assign(env, { MONGODB_URI: "mongodb://localhost/db", DATABASE_URL: "postgres://localhost/db", REDIS_URL: "redis://localhost" });
    redis.status = "wait";
    connectMongoMock.mockResolvedValue({ connected: true });
    connectPrisma.mockResolvedValue(undefined);
    connectRedis.mockResolvedValue(undefined);
    getPrismaMock.mockReturnValue({ $connect: connectPrisma });
    getRedisMock.mockReturnValue(redis);
    aiWorker.close.mockResolvedValue(undefined);
    routingWorker.close.mockResolvedValue(undefined);
    startAiWorkerMock.mockReturnValue(aiWorker);
    startRoutingWorkerMock.mockReturnValue(routingWorker);
    mongooseDisconnectMock.mockResolvedValue(undefined);
    [closeRoutingQueue, closeDeadLetterQueue, disconnectPostgres, closeRedis].forEach((fn) =>
      (fn as unknown as jest.Mock).mockResolvedValue(undefined)
    );
    processOn = jest.spyOn(process, "on").mockImplementation(() => process) as unknown as jest.Mock;
    processExit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never) as unknown as jest.Mock;
    log = jest.spyOn(console, "log").mockImplementation(() => undefined) as unknown as jest.Mock;
  });

  afterEach(() => {
    processOn.mockRestore();
    processExit.mockRestore();
    log.mockRestore();
    Object.assign(env, { MONGODB_URI: undefined, DATABASE_URL: undefined, REDIS_URL: undefined });
  });

  test("refuses to start without MongoDB, PostgreSQL and Redis settings", async () => {
    for (const name of REQUIRED) {
      Object.assign(env, { [name]: undefined });
      await expect(start()).rejects.toThrow("Worker requires MONGODB_URI, DATABASE_URL and REDIS_URL");
      Object.assign(env, { [name]: "set" });
    }
    expect(connectMongoMock).not.toHaveBeenCalled();
    expect(startAiWorkerMock).not.toHaveBeenCalled();
  });

  test("connects the databases before it starts both workers", async () => {
    await start();

    expect(connectMongoMock).toHaveBeenCalledTimes(1);
    expect(connectPrisma).toHaveBeenCalledTimes(1);
    expect(connectRedis).toHaveBeenCalledTimes(1);
    expect(startAiWorkerMock).toHaveBeenCalledTimes(1);
    expect(startRoutingWorkerMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[worker] AI decision worker started");
  });

  test("does not reconnect a Redis client that is already connecting or ready", async () => {
    redis.status = "ready";

    await start();

    expect(connectRedis).not.toHaveBeenCalled();
  });

  test("logs completed routing jobs as delivered or with the reason they were not", async () => {
    await start();
    const completed = workerHandler(routingWorker, "completed");

    completed({ id: "j1" }, { delivered: true, status: 202 });
    completed({ id: "j2" }, { delivered: false, reason: "not_configured" });

    expect(log).toHaveBeenCalledWith("[routing-worker] job j1: delivered");
    expect(log).toHaveBeenCalledWith("[routing-worker] job j2: not_configured");
  });

  test("logs failed jobs, including stalled ones that have no job object", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await start();

    workerHandler(aiWorker, "failed")({ id: "j1" }, new Error("model down"));
    workerHandler(routingWorker, "failed")(undefined, new Error("stalled"));

    expect(error).toHaveBeenCalledWith("[worker] failed j1:", "model down");
    expect(error).toHaveBeenCalledWith("[routing-worker] failed undefined:", "stalled");
    error.mockRestore();
  });

  test("shuts down once on repeated signals and closes everything it opened", async () => {
    await start();
    const onSigterm = signalHandler("SIGTERM");
    const onSigint = signalHandler("SIGINT");

    onSigterm();
    onSigint();
    await flushPromises();

    expect(aiWorker.close).toHaveBeenCalledTimes(1);
    expect(routingWorker.close).toHaveBeenCalledTimes(1);
    expect(closeRoutingQueue).toHaveBeenCalledTimes(1);
    expect(closeDeadLetterQueue).toHaveBeenCalledTimes(1);
    expect(disconnectPostgres).toHaveBeenCalledTimes(1);
    expect(closeRedis).toHaveBeenCalledTimes(1);
    expect(mongooseDisconnectMock).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledTimes(1);
    expect(callArgs(processExit)).toEqual([0]);
  });

  test("exits with an error code when a worker cannot be closed", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    aiWorker.close.mockRejectedValue(new Error("stuck job"));
    await start();

    signalHandler("SIGTERM")();
    await flushPromises();

    expect(error).toHaveBeenCalledWith("[worker] shutdown failed:", "stuck job");
    expect(callArgs(processExit)).toEqual([1]);
    error.mockRestore();
  });
});
