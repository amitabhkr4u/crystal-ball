import { z } from "zod";
import { env } from "../config/env";
import { llmLatency, llmRequests, llmTokens } from "../observability/metrics";
import { recordLlmUsage } from "./llmCost.service";
import { createProviderCircuit } from "./providerCircuit";

const EMBEDDING_DIMENSIONS = 1536;
const MAX_INPUTS = 64;
const MAX_INPUT_CHARS = 8000;

const EmbeddingUsage = z.object({ usage: z.object({ prompt_tokens: z.number().int().nonnegative() }) });

const EmbeddingResponse = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional() }).optional()
});

// The provider answered with an HTTP error status.
export class EmbeddingProviderError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Embedding provider returned ${status}`);
    this.name = "EmbeddingProviderError";
    this.status = status;
  }
}

// True for an outage (network failure, timeout, 408, 429, 5xx). Other 4xx answers are our own mistake.
export function isEmbeddingsInfraFailure(error: unknown): boolean {
  if (error instanceof EmbeddingProviderError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

// Separate from the Anthropic breaker: a different provider can be down on its own.
export const embeddingsCircuit = createProviderCircuit("embeddings", isEmbeddingsInfraFailure);

// Closes the circuit; used by tests so one test's failures do not leak into the next.
export function resetEmbeddingsCircuit(): void {
  embeddingsCircuit.reset();
}

// Throws unless the inputs are 1 to 64 non-empty strings (callers may be untyped JavaScript).
function assertEmbeddingInputs(inputs: unknown): asserts inputs is string[] {
  if (
    !Array.isArray(inputs) ||
    inputs.length < 1 ||
    inputs.length > MAX_INPUTS ||
    inputs.some((item: unknown) => typeof item !== "string" || !item.trim())
  ) {
    throw new TypeError("Embedding input must contain 1 to 64 non-empty strings");
  }
}

// Gets embedding vectors for text from the provider; null when no API key is configured.
export async function createEmbeddings(inputs: readonly string[], tenantId = "system"): Promise<number[][] | null> {
  if (!env.EMBEDDINGS_API_KEY) return null;
  assertEmbeddingInputs(inputs);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);
  try {
    // Request and body read share one breaker call, so a stalled body counts like a stalled request.
    const body = await embeddingsCircuit.exec(async () => {
      const response = await fetch(env.EMBEDDINGS_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.EMBEDDINGS_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.EMBEDDINGS_MODEL, input: inputs.map((item) => item.slice(0, MAX_INPUT_CHARS)) }),
        signal: controller.signal
      });
      if (!response.ok) throw new EmbeddingProviderError(response.status);
      const json: unknown = await response.json();
      return json;
    });
    const parsed = EmbeddingResponse.safeParse(body);
    const usage = EmbeddingUsage.safeParse(body);
    const promptTokens = usage.success ? usage.data.usage.prompt_tokens : undefined;
    if (promptTokens !== undefined) {
      llmTokens.inc({ feature: "embeddings", model: env.EMBEDDINGS_MODEL, direction: "input" }, promptTokens);
      try {
        await recordLlmUsage({
          tenantId,
          feature: "embeddings",
          model: env.EMBEDDINGS_MODEL,
          inputTokens: promptTokens,
          outputTokens: 0,
          inputRateUsdPerMillion: env.EMBEDDINGS_INPUT_USD_PER_MILLION,
          outputRateUsdPerMillion: 0
        });
      } catch (error: unknown) {
        console.error("[llm-cost] embedding usage persistence failed:", error instanceof Error ? error.message : "unknown error");
      }
    }

    const rows = parsed.success ? parsed.data.data : [];
    if (rows.length !== inputs.length) throw new Error("Embedding provider returned an unexpected vector count");
    const embeddings = [...rows].sort((a, b) => a.index - b.index).map((row) => row.embedding);
    if (embeddings.some((vector) => vector.length !== EMBEDDING_DIMENSIONS || vector.some((n) => !Number.isFinite(n)))) {
      throw new Error("Embedding provider returned an invalid vector");
    }
    llmRequests.inc({ feature: "embeddings", model: env.EMBEDDINGS_MODEL, outcome: "success" });
    llmLatency.observe({ feature: "embeddings", model: env.EMBEDDINGS_MODEL }, (Date.now() - startedAt) / 1000);
    return embeddings;
  } finally {
    clearTimeout(timeout);
  }
}

// Gets one embedding vector for a single text.
export async function createEmbedding(input: string, tenantId = "system"): Promise<number[] | null> {
  const result = await createEmbeddings([String(input)], tenantId);
  return result?.[0] ?? null;
}
