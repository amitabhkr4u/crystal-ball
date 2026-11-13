import { env } from "../config/env";
import { getRedis } from "../db/redis";
import { LlmUsage } from "../models/LlmUsage";
import { mongoose } from "../db/mongo";
import { llmCostUsd } from "../observability/metrics";

export interface LlmUsageInput {
  tenantId: string;
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputRateUsdPerMillion?: number;
  outputRateUsdPerMillion?: number;
}

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);
const roundCost = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export function calculateLlmCost(inputTokens: number, outputTokens: number, inputRate: number, outputRate: number) {
  const inputCostUsd = roundCost((Math.max(0, inputTokens) / 1_000_000) * inputRate);
  const outputCostUsd = roundCost((Math.max(0, outputTokens) / 1_000_000) * outputRate);
  return { inputCostUsd, outputCostUsd, totalCostUsd: roundCost(inputCostUsd + outputCostUsd) };
}

async function sendBudgetAlert(tenantId: string, day: string, spendUsd: number): Promise<void> {
  if (!env.LLM_DAILY_BUDGET_USD || spendUsd < env.LLM_DAILY_BUDGET_USD || !env.ONCALL_WEBHOOK_URL) return;
  const redis = getRedis();
  const key = `llm:budget-alert:${tenantId}:${day}`;
  const claimed = await redis.set(key, "1", "EX", 172800, "NX");
  if (claimed !== "OK") return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.ONCALL_TIMEOUT_MS);
  try {
    const response = await fetch(env.ONCALL_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.ONCALL_WEBHOOK_TOKEN ? { authorization: `Bearer ${env.ONCALL_WEBHOOK_TOKEN}` } : {})
      },
      body: JSON.stringify({
        event: "llm.daily_budget_exceeded",
        tenantId,
        day,
        spendUsd: roundCost(spendUsd),
        budgetUsd: env.LLM_DAILY_BUDGET_USD,
        currency: "USD"
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Budget alert webhook returned HTTP ${response.status}`);
  } catch (error) {
    await redis.del(key);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Persists provider-priced usage and sends one alert per tenant/day after the configured budget is crossed.
export async function recordLlmUsage(input: LlmUsageInput): Promise<void> {
  if (!input.tenantId || !Number.isFinite(input.inputTokens) || !Number.isFinite(input.outputTokens)) return;
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is not connected; LLM usage was not persisted");
  const now = new Date();
  const day = dayKey(now);
  const inputRateUsdPerMillion = input.inputRateUsdPerMillion ?? env.LLM_INPUT_USD_PER_MILLION;
  const outputRateUsdPerMillion = input.outputRateUsdPerMillion ?? env.LLM_OUTPUT_USD_PER_MILLION;
  const cost = calculateLlmCost(
    input.inputTokens,
    input.outputTokens,
    inputRateUsdPerMillion,
    outputRateUsdPerMillion
  );

  await LlmUsage.create({
    tenantId: input.tenantId,
    feature: input.feature,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    inputRateUsdPerMillion,
    outputRateUsdPerMillion,
    ...cost,
    occurredAt: now,
    dayKey: day
  });
  llmCostUsd.inc({ feature: input.feature, model: input.model }, cost.totalCostUsd);

  if (env.LLM_DAILY_BUDGET_USD > 0 && env.ONCALL_WEBHOOK_URL) {
    const aggregate = await LlmUsage.aggregate([
      { $match: { tenantId: input.tenantId, dayKey: day } },
      { $group: { _id: null, spendUsd: { $sum: "$totalCostUsd" } } }
    ]);
    await sendBudgetAlert(input.tenantId, day, Number(aggregate[0]?.spendUsd || 0));
  }
}

// Returns the authenticated tenant's usage total for the current UTC day.
export async function getDailyLlmUsage(tenantId: string) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is not connected; usage totals are unavailable");
  const day = dayKey(new Date());
  const aggregate = await LlmUsage.aggregate([
    { $match: { tenantId, dayKey: day } },
    {
      $group: {
        _id: null,
        requests: { $sum: 1 },
        inputTokens: { $sum: "$inputTokens" },
        outputTokens: { $sum: "$outputTokens" },
        spendUsd: { $sum: "$totalCostUsd" }
      }
    }
  ]);
  const result = aggregate[0] || { requests: 0, inputTokens: 0, outputTokens: 0, spendUsd: 0 };
  return {
    day,
    currency: "USD",
    ...result,
    budgetUsd: env.LLM_DAILY_BUDGET_USD,
    budgetExceeded: env.LLM_DAILY_BUDGET_USD > 0 && result.spendUsd >= env.LLM_DAILY_BUDGET_USD
  };
}
