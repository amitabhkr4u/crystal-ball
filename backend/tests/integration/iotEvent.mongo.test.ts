import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { IoTEvent, SmokeEvent, type EventSeverity, type IoTEventAttrs } from "../../src/models/IoTEvent";

describe("IoT event persistence", () => {
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await IoTEvent.init();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  afterEach(async () => {
    await IoTEvent.deleteMany({});
  });

  const event: IoTEventAttrs = {
    tenantId: "tenant-a",
    siteId: "site-a",
    sensorId: "smoke-01",
    occurredAt: new Date(),
    severity: "P0",
    payload: { smokeLevel: 0.98 },
    classification: null,
    dedupeKey: "tenant-a:alert-1"
  };

  it("persists tenant-scoped events and rejects duplicate tenant alert keys", async () => {
    const saved = await IoTEvent.create(event);
    expect(saved.tenantId).toBe("tenant-a");
    await expect(IoTEvent.create(event)).rejects.toMatchObject({ code: 11000 });
  });

  it("allows the same dedupe key for a different tenant", async () => {
    await IoTEvent.create(event);
    await expect(IoTEvent.create({ ...event, tenantId: "tenant-b" })).resolves.toMatchObject({ tenantId: "tenant-b" });
  });

  it("rejects an unknown severity", async () => {
    const invalid = "P9" as unknown as EventSeverity;
    await expect(IoTEvent.create({ ...event, severity: invalid })).rejects.toThrow(/severity/);
  });

  it("stores discriminator events with their type and required fields", async () => {
    const smoke = await SmokeEvent.create({ ...event, dedupeKey: "tenant-a:smoke-1", smokeLevel: 0.9 });
    expect(smoke.get("eventType")).toBe("SmokeEvent");
    const missingLevel = { ...event, dedupeKey: "tenant-a:smoke-2" } as unknown as Parameters<typeof SmokeEvent.create>[0];
    await expect(SmokeEvent.create(missingLevel)).rejects.toThrow(/smokeLevel/);
  });
});
