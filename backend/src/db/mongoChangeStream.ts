import { z } from "zod";
import { IoTEvent } from "../models/IoTEvent";
import { errorMessage } from "../utils/errors";
import { getRedis } from "./redis";

const CHANNEL = "iot:event:changed";

// Only the fields we publish; anything else on the document is ignored.
const changeSchema = z.object({
  fullDocument: z
    .object({
      _id: z.unknown(),
      tenantId: z.string().min(1),
      siteId: z.unknown(),
      sensorId: z.unknown(),
      severity: z.unknown(),
      occurredAt: z.unknown(),
      classification: z.unknown()
    })
    .optional()
});

// Publishes IoT event changes to Redis for live updates.
export function watchIoTEvents() {
  const stream = IoTEvent.watch([{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }], {
    fullDocument: "updateLookup"
  });

  // The listener takes `unknown` on purpose: the driver's change type is a large union,
  // and we validate just the part we need.
  stream.on("change", async (change: unknown) => {
    const parsed = changeSchema.safeParse(change);
    const event = parsed.success ? parsed.data.fullDocument : undefined;
    if (!event) return;
    const payload = {
      eventId: String(event._id),
      tenantId: event.tenantId,
      siteId: event.siteId,
      sensorId: event.sensorId,
      severity: event.severity,
      occurredAt: event.occurredAt,
      classification: event.classification || null
    };
    try {
      await getRedis().publish(CHANNEL, JSON.stringify(payload));
    } catch (error) {
      console.error("[mongo-change-stream] publish failed:", errorMessage(error));
    }
  });
  stream.on("error", (error: unknown) => console.error("[mongo-change-stream] stream error:", errorMessage(error)));
  return stream;
}
