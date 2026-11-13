import Anthropic from "@anthropic-ai/sdk";
import { getRedis } from "../../src/db/redis";
import { Classification, classifyAlert, deterministicFallback } from "../../src/services/aiDecision.service";
import { getAnthropicClient } from "../../src/services/llmClient";
import { resetLlmCircuit } from "../../src/services/llmCircuit";
import type { AlertInput } from "../../src/types/alert";

jest.mock("../../src/config/env", () => ({
  env: { ANTHROPIC_MODEL: "test-model", REDIS_URL: "redis://cache.test", LLM_CACHE_TTL_SECONDS: 60 }
}));
jest.mock("../../src/services/llmClient", () => ({ getAnthropicClient: jest.fn() }));
jest.mock("../../src/db/redis", () => ({ getRedis: jest.fn() }));

const clientMock = getAnthropicClient as unknown as jest.Mock;
const redisMock = getRedis as unknown as jest.Mock;
const create = jest.fn();
const redis = { get: jest.fn(), set: jest.fn() };

const alert: AlertInput = { tenantId: "t1", siteId: "site-a", sensorId: "smoke-01", severity: "P0" };
const validOutput = {
  severity: "P0",
  likelyRootCause: "Smoke detected near the boiler",
  urgency: "immediate",
  confidence: 0.9,
  operatorSummary: "Inspect zone A now",
  recommendedChecks: ["Inspect sensor"],
  requiresHumanConfirmation: true
};
const modelReply = (text: string): unknown => ({
  content: [{ type: "text", text }],
  usage: { input_tokens: 12, output_tokens: 34 }
});

describe("AI decision fallback", () => {
  it("keeps P0 alerts immediate and requires human confirmation", () => {
    const result = deterministicFallback({ severity: "P0", siteId: "site-a", sensorId: "smoke-01" });
    expect(result.urgency).toBe("immediate");
    expect(result.requiresHumanConfirmation).toBe(true);
    expect(result.severity).toBe("P0");
    expect(Classification.safeParse(result).success).toBe(true);
  });

  it("returns a safe P2 fallback when severity is absent", () => {
    const result = deterministicFallback({ siteId: "site-a", sensorId: "temp-01" });
    expect(result.severity).toBe("P2");
    expect(result.urgency).toBe("routine");
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("AI decision service", () => {
  beforeEach(() => {
    resetLlmCircuit();
    create.mockReset();
    redis.get.mockReset();
    redis.set.mockReset();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue("OK");
    clientMock.mockReturnValue({ messages: { create } });
    redisMock.mockReturnValue(redis);
  });

  it("uses the deterministic fallback when no LLM key is configured", async () => {
    clientMock.mockReturnValue(null);
    const result = await classifyAlert({ alert: { severity: "P1", siteId: "site-b", sensorId: "smoke-02" } });
    expect(result.fallback).toBe(true);
    expect(result.urgency).toBe("same_shift");
    expect(result.requiresHumanConfirmation).toBe(true);
  });

  it("returns the validated model output and caches it per tenant", async () => {
    create.mockResolvedValue(modelReply(JSON.stringify(validOutput)));
    const result = await classifyAlert({ alert });
    expect(result).toMatchObject({
      severity: "P0",
      fallback: false,
      model: "test-model",
      promptVersion: "alert-classification.v1",
      usage: { input_tokens: 12, output_tokens: 34 }
    });
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, , mode, ttl] = redis.set.mock.calls[0] as unknown as [string, string, string, number];
    expect(key.startsWith("llm:classification:t1:")).toBe(true);
    expect([mode, ttl]).toEqual(["EX", 60]);
  });

  it("reuses cache entries when history differs only by MongoDB metadata", async () => {
    create.mockResolvedValue(modelReply(JSON.stringify(validOutput)));
    await classifyAlert({
      alert,
      history: [{ _id: "mongo-id-1", createdAt: "2026-01-01", sensorValue: 12, severity: "P0" }]
    });
    redis.get.mockResolvedValue(
      JSON.stringify({ ...validOutput, fallback: false, promptVersion: "alert-classification.v1", model: "test-model", latencyMs: 5, usage: { input_tokens: 12, output_tokens: 34 } })
    );
    const cached = await classifyAlert({
      alert,
      history: [{ _id: "mongo-id-2", createdAt: "2026-02-01", sensorValue: 12, severity: "P0" }]
    });
    expect(cached.cached).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("accepts JSON wrapped in a markdown code fence", async () => {
    create.mockResolvedValue(modelReply(`\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``));
    expect((await classifyAlert({ alert })).fallback).toBe(false);
  });

  it("falls back when the model output is not valid JSON or breaks the schema", async () => {
    create.mockResolvedValue(modelReply("I think it is fine"));
    expect(await classifyAlert({ alert })).toMatchObject({ fallback: true, fallbackReason: "invalid_llm_output" });
    create.mockResolvedValue(modelReply(JSON.stringify({ ...validOutput, requiresHumanConfirmation: false })));
    expect(await classifyAlert({ alert })).toMatchObject({ fallback: true, fallbackReason: "invalid_llm_output" });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("reports SDK timeouts as llm_timeout and other failures as llm_unavailable", async () => {
    create.mockRejectedValue(new Anthropic.APIConnectionTimeoutError());
    expect(await classifyAlert({ alert })).toMatchObject({ fallback: true, fallbackReason: "llm_timeout" });
    create.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(await classifyAlert({ alert })).toMatchObject({ fallbackReason: "llm_timeout" });
    create.mockRejectedValue(new Error("boom"));
    expect(await classifyAlert({ alert })).toMatchObject({ fallbackReason: "llm_unavailable" });
  });

  it("serves a valid cache hit without calling the model", async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({ ...validOutput, fallback: false, promptVersion: "alert-classification.v1", model: "m", latencyMs: 5, usage: { input_tokens: 1, output_tokens: 2 } })
    );
    const result = await classifyAlert({ alert });
    expect(result.cached).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("ignores a cache entry that fails validation", async () => {
    redis.get.mockResolvedValue(JSON.stringify({ ...validOutput, requiresHumanConfirmation: false }));
    create.mockResolvedValue(modelReply(JSON.stringify(validOutput)));
    const result = await classifyAlert({ alert });
    expect(result.cached).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("still classifies when Redis is down", async () => {
    redis.get.mockRejectedValue(new Error("redis down"));
    redis.set.mockRejectedValue(new Error("redis down"));
    create.mockResolvedValue(modelReply(JSON.stringify(validOutput)));
    expect((await classifyAlert({ alert })).fallback).toBe(false);
  });

  describe("circuit breaker", () => {
    const THRESHOLD = 5; // the default LLM_CIRCUIT_FAILURE_THRESHOLD (the env mock above sets none)

    it("stops calling the model after repeated outage failures and falls back with circuit_open", async () => {
      create.mockRejectedValue(new Anthropic.APIConnectionTimeoutError());
      for (let i = 0; i < THRESHOLD; i += 1) {
        expect(await classifyAlert({ alert })).toMatchObject({ fallbackReason: "llm_timeout" });
      }
      const result = await classifyAlert({ alert });
      expect(result).toMatchObject({ fallback: true, fallbackReason: "circuit_open", urgency: "immediate" });
      expect(create).toHaveBeenCalledTimes(THRESHOLD);
    });

    it("does not trip on client errors such as 400", async () => {
      create.mockRejectedValue(Object.assign(Object.create(Anthropic.APIError.prototype), { status: 400 }));
      for (let i = 0; i < THRESHOLD + 1; i += 1) {
        expect(await classifyAlert({ alert })).toMatchObject({ fallbackReason: "llm_unavailable" });
      }
      expect(create).toHaveBeenCalledTimes(THRESHOLD + 1);
    });

    it("does not trip on invalid model output (the model answered)", async () => {
      create.mockResolvedValue(modelReply("not json"));
      for (let i = 0; i < THRESHOLD + 1; i += 1) await classifyAlert({ alert });
      expect(create).toHaveBeenCalledTimes(THRESHOLD + 1);
    });

    it("still serves cache hits while the circuit is open", async () => {
      create.mockRejectedValue(new Anthropic.APIConnectionTimeoutError());
      for (let i = 0; i < THRESHOLD; i += 1) await classifyAlert({ alert });
      redis.get.mockResolvedValue(
        JSON.stringify({ ...validOutput, fallback: false, promptVersion: "alert-classification.v1", model: "m", latencyMs: 5, usage: { input_tokens: 1, output_tokens: 2 } })
      );
      const result = await classifyAlert({ alert });
      expect(result.cached).toBe(true);
      expect(create).toHaveBeenCalledTimes(THRESHOLD);
    });
  });
});
