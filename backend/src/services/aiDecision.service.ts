import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { getRedis } from "../db/redis";
import type { EventSeverity } from "../models/IoTEvent";
import { llmFallbacks, llmLatency, llmRequests, llmTokens } from "../observability/metrics";
import { alertClassificationPrompt as prompt } from "../prompts/alertClassification.v1";
import type { AlertInput } from "../types/alert";
import { CircuitOpenError } from "../utils/circuitBreaker";
import { errorMessage } from "../utils/errors";
import { getAnthropicClient } from "./llmClient";
import { llmCircuit } from "./llmCircuit";
import { recordLlmUsage } from "./llmCost.service";

const FEATURE = "alert_classification";

export const Classification = z.object({
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  likelyRootCause: z.string().min(1).max(500),
  urgency: z.enum(["immediate", "same_shift", "next_shift", "routine"]),
  confidence: z.number().min(0).max(1),
  operatorSummary: z.string().min(1).max(1200),
  recommendedChecks: z.array(z.string().min(1).max(300)).max(8),
  requiresHumanConfirmation: z.literal(true)
});

export type ClassificationResult = z.infer<typeof Classification>;
type Urgency = ClassificationResult["urgency"];

export type FallbackReason =
  | "no_api_key"
  | "llm_timeout"
  | "invalid_llm_output"
  | "llm_unavailable"
  | "circuit_open";

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ClassificationMeta {
  fallback: boolean;
  promptVersion: string;
  fallbackReason?: FallbackReason;
  model?: string;
  latencyMs?: number;
  usage?: LlmUsage;
  cached?: true;
}

export type ClassificationResponse = ClassificationResult & ClassificationMeta;

export interface ClassifyInput {
  alert: AlertInput;
  history?: readonly unknown[];
  retrievedDocs?: readonly unknown[];
}

// What a successful (non-fallback) response looks like once read back from the cache.
const CachedResponse = Classification.extend({
  fallback: z.literal(false),
  promptVersion: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() })
});

const URGENCY_BY_SEVERITY: Partial<Record<EventSeverity, Urgency>> = { P0: "immediate", P1: "same_shift" };

const OUTPUT_SHAPE = {
  severity: ["P0", "P1", "P2", "P3"],
  likelyRootCause: "string",
  urgency: ["immediate", "same_shift", "next_shift", "routine"],
  confidence: "0..1",
  operatorSummary: "string",
  recommendedChecks: ["string"],
  requiresHumanConfirmation: true
};

// Builds a safe rule-based classification without calling the LLM.
export function deterministicFallback(alert: AlertInput): ClassificationResult {
  return Classification.parse({
    severity: alert.severity || "P2",
    likelyRootCause: "AI analysis unavailable; verify the sensor, power, connectivity, and recent maintenance history.",
    urgency: (alert.severity && URGENCY_BY_SEVERITY[alert.severity]) || "routine",
    confidence: 0.25,
    operatorSummary: `Fallback triage for ${alert.sensorId || "unknown sensor"} at site ${alert.siteId || "unknown site"}. Human review is required.`,
    recommendedChecks: [
      "Verify the sensor reading against an independent measurement",
      "Check sensor power and connectivity",
      "Review recent maintenance and related alerts"
    ],
    requiresHumanConfirmation: true
  });
}

// Adds fallback flags to the rule-based classification.
function fallbackResult(
  alert: AlertInput,
  extra: { fallbackReason?: FallbackReason; model?: string; latencyMs?: number } = {}
): ClassificationResponse {
  return { ...deterministicFallback(alert), fallback: true, promptVersion: prompt.version, ...extra };
}

// True when the error means the LLM call ran out of time.
function isTimeout(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return error instanceof Anthropic.APIError && error.status === 408;
}

// Picks the fallback reason from the error type.
function fallbackReason(error: unknown): FallbackReason {
  if (error instanceof CircuitOpenError) return "circuit_open";
  if (isTimeout(error)) return "llm_timeout";
  if (error instanceof SyntaxError || error instanceof z.ZodError) return "invalid_llm_output";
  return "llm_unavailable";
}

// Reads the model text and parses it as JSON.
function parseModelOutput(result: Anthropic.Message): ClassificationResult {
  const text = result.content.find((part): part is Anthropic.TextBlock => part.type === "text")?.text ?? "";
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return Classification.parse(JSON.parse(json));
}

// Removes database-generated metadata and sorts object keys for stable cache inputs.
function normalizeCacheInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCacheInput);
  if (value && typeof value === "object") {
    const volatileFields = new Set(["_id", "id", "__v", "createdAt", "updatedAt", "processedAt"]);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !volatileFields.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeCacheInput(entry)])
    );
  }
  return value;
}

// Builds the Redis cache key from stable domain data, not MongoDB-generated metadata.
function buildCacheKey(alert: AlertInput, history: readonly unknown[], retrievedDocs: readonly unknown[]): string {
  const input = JSON.stringify(normalizeCacheInput({ version: prompt.version, alert, history, retrievedDocs }));
  const digest = crypto.createHash("sha256").update(input).digest("hex");
  return `llm:classification:${alert.tenantId || "unscoped"}:${digest}`;
}

// Reads a cached classification, ignoring cache errors and entries that fail validation.
async function readCache(key: string): Promise<ClassificationResponse | null> {
  if (!env.REDIS_URL) return null;
  try {
    const cached = await getRedis().get(key);
    if (!cached) return null;
    const parsed = CachedResponse.safeParse(JSON.parse(cached));
    if (!parsed.success) {
      console.warn("[ai] cache entry ignored: failed validation");
      return null;
    }
    return { ...parsed.data, cached: true };
  } catch (error: unknown) {
    console.warn("[ai] cache read skipped:", errorMessage(error));
    return null;
  }
}

// Stores a classification in the cache, ignoring cache errors.
async function writeCache(key: string, response: ClassificationResponse): Promise<void> {
  if (!env.REDIS_URL) return;
  try {
    await getRedis().set(key, JSON.stringify(response), "EX", env.LLM_CACHE_TTL_SECONDS);
  } catch (error: unknown) {
    console.warn("[ai] cache write skipped:", errorMessage(error));
  }
}

// Records request, latency and token metrics for one LLM call.
async function recordSuccess(model: string, seconds: number, usage: LlmUsage | undefined, tenantId?: string): Promise<void> {
  llmRequests.inc({ feature: FEATURE, model, outcome: "success" });
  llmLatency.observe({ feature: FEATURE, model }, seconds);
  if (!usage) return;
  llmTokens.inc({ feature: FEATURE, model, direction: "input" }, usage.input_tokens || 0);
  llmTokens.inc({ feature: FEATURE, model, direction: "output" }, usage.output_tokens || 0);
  if (tenantId) {
    try {
      await recordLlmUsage({
        tenantId,
        feature: FEATURE,
        model,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0
      });
    } catch (error: unknown) {
      console.error("[llm-cost] usage persistence or budget alert failed:", errorMessage(error));
    }
  }
}

// Classifies an alert with the LLM and falls back to rules on failure.
export async function classifyAlert({
  alert,
  history = [],
  retrievedDocs = []
}: ClassifyInput): Promise<ClassificationResponse> {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    llmFallbacks.inc({ feature: FEATURE, reason: "no_api_key" });
    return fallbackResult(alert);
  }

  const model = env.ANTHROPIC_MODEL;
  const startedAt = Date.now();
  const cacheKey = buildCacheKey(alert, history, retrievedDocs);

  try {
    const cached = await readCache(cacheKey);
    if (cached) return cached;

    // Only the network call goes through the breaker: a model that answers with bad JSON is not an outage.
    const result = await llmCircuit.exec(() =>
      anthropic.messages.create({
        model,
        max_tokens: 700,
        system: prompt.system,
        messages: [
          {
            role: "user",
            content: `${prompt.user(alert, history, retrievedDocs)}\nJSON schema: ${JSON.stringify(OUTPUT_SHAPE)}`
          }
        ]
      })
    );
    const latencyMs = Date.now() - startedAt;
    await recordSuccess(model, latencyMs / 1000, result.usage, alert.tenantId);
    const output = parseModelOutput(result);

    const response: ClassificationResponse = {
      ...output,
      fallback: false,
      promptVersion: prompt.version,
      model,
      latencyMs,
      usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens }
    };
    await writeCache(cacheKey, response);
    return response;
  } catch (error: unknown) {
    const reason = fallbackReason(error);
    const latencyMs = Date.now() - startedAt;
    llmRequests.inc({ feature: FEATURE, model, outcome: "fallback" });
    llmFallbacks.inc({ feature: FEATURE, reason });
    if (reason !== "circuit_open") llmLatency.observe({ feature: FEATURE, model }, latencyMs / 1000); // no call was made
    return fallbackResult(alert, { fallbackReason: reason, model, latencyMs });
  }
}
