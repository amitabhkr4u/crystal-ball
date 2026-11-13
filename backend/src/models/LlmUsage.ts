import { Schema, type Model } from "mongoose";
import { mongoose } from "../db/mongo";

export interface LlmUsageAttrs {
  tenantId: string;
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  inputRateUsdPerMillion: number;
  outputRateUsdPerMillion: number;
  totalCostUsd: number;
  occurredAt: Date;
  dayKey: string;
}

const schema = new Schema<LlmUsageAttrs>({
  tenantId: { type: String, required: true, index: true },
  feature: { type: String, required: true },
  model: { type: String, required: true },
  inputTokens: { type: Number, required: true, min: 0 },
  outputTokens: { type: Number, required: true, min: 0 },
  inputCostUsd: { type: Number, required: true, min: 0 },
  outputCostUsd: { type: Number, required: true, min: 0 },
  inputRateUsdPerMillion: { type: Number, required: true, min: 0 },
  outputRateUsdPerMillion: { type: Number, required: true, min: 0 },
  totalCostUsd: { type: Number, required: true, min: 0 },
  occurredAt: { type: Date, required: true, default: Date.now },
  dayKey: { type: String, required: true }
}, { timestamps: true, collection: "llm_usage" });

schema.index({ tenantId: 1, dayKey: 1, occurredAt: -1 });
schema.index({ occurredAt: 1 }, { expireAfterSeconds: 31536000 });

export const LlmUsage: Model<LlmUsageAttrs> =
  (mongoose.models.LlmUsage as Model<LlmUsageAttrs> | undefined) ??
  mongoose.model<LlmUsageAttrs>("LlmUsage", schema);
