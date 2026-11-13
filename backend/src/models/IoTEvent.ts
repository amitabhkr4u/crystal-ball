import { Schema, type Model } from "mongoose";
import { mongoose } from "../db/mongo";

export const EVENT_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export interface IoTEventAttrs {
  tenantId: string;
  siteId: string;
  sensorId: string;
  occurredAt: Date;
  severity: EventSeverity;
  payload: Record<string, unknown>;
  classification: Record<string, unknown> | null;
  dedupeKey: string;
}

export interface SmokeEventAttrs extends IoTEventAttrs {
  smokeLevel: number;
  batteryPct?: number;
}

export interface TemperatureEventAttrs extends IoTEventAttrs {
  temperatureC: number;
  humidityPct?: number;
}

const baseOptions = { timestamps: true, discriminatorKey: "eventType", collection: "iot_events" };

const eventSchema = new Schema<IoTEventAttrs>(
  {
    tenantId: { type: String, required: true, index: true },
    siteId: { type: String, required: true, index: true },
    sensorId: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    severity: { type: String, enum: [...EVENT_SEVERITIES], required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    classification: { type: Schema.Types.Mixed, default: null },
    dedupeKey: { type: String, required: true }
  },
  baseOptions
);

eventSchema.index({ tenantId: 1, siteId: 1, occurredAt: -1 });
eventSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
eventSchema.index({ occurredAt: 1 }, { expireAfterSeconds: 7776000 });

// Reuses an already registered model (hot reload / repeated imports) instead of recompiling it.
export const IoTEvent: Model<IoTEventAttrs> =
  (mongoose.models.IoTEvent as Model<IoTEventAttrs> | undefined) ?? mongoose.model<IoTEventAttrs>("IoTEvent", eventSchema);

export const SmokeEvent: Model<SmokeEventAttrs> =
  (IoTEvent.discriminators?.SmokeEvent as Model<SmokeEventAttrs> | undefined) ??
  IoTEvent.discriminator<SmokeEventAttrs>(
    "SmokeEvent",
    new Schema<SmokeEventAttrs>({ smokeLevel: { type: Number, required: true }, batteryPct: Number })
  );

export const TemperatureEvent: Model<TemperatureEventAttrs> =
  (IoTEvent.discriminators?.TemperatureEvent as Model<TemperatureEventAttrs> | undefined) ??
  IoTEvent.discriminator<TemperatureEventAttrs>(
    "TemperatureEvent",
    new Schema<TemperatureEventAttrs>({ temperatureC: { type: Number, required: true }, humidityPct: Number })
  );
