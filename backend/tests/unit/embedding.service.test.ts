import { env } from "../../src/config/env";
import { createEmbedding, createEmbeddings, resetEmbeddingsCircuit } from "../../src/services/embedding.service";
import { CircuitOpenError } from "../../src/utils/circuitBreaker";
import { recordLlmUsage } from "../../src/services/llmCost.service";

jest.mock("../../src/services/llmCost.service", () => ({
  recordLlmUsage: jest.fn().mockResolvedValue(undefined)
}));

jest.mock("../../src/config/env", () => ({
  env: {
    EMBEDDINGS_API_KEY: "key",
    EMBEDDINGS_API_URL: "https://embeddings.test/v1",
    EMBEDDINGS_MODEL: "embed-test",
    EMBEDDINGS_INPUT_USD_PER_MILLION: 0.02,
    LLM_TIMEOUT_MS: 1000
  }
}));

const fetchMock = jest.fn();
const realFetch = globalThis.fetch;

const vector = (value: number): number[] => new Array<number>(1536).fill(value);
const reply = (data: unknown, ok = true, status = 200): unknown => ({ ok, status, json: async () => data });

describe("embedding service", () => {
  beforeEach(() => {
    resetEmbeddingsCircuit();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns vectors in input order even if the provider shuffles them", async () => {
    fetchMock.mockResolvedValue(
      reply({ data: [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) }] })
    );
    const result = await createEmbeddings(["a", "b"]);
    expect(result?.[0]?.[0]).toBe(1);
    expect(result?.[1]?.[0]).toBe(2);
  });

  test("records tenant-scoped embedding token usage and configured pricing", async () => {
    fetchMock.mockResolvedValue(reply({
      data: [{ index: 0, embedding: vector(1) }],
      usage: { prompt_tokens: 42 }
    }));
    await createEmbeddings(["tenant document"], "tenant-a");
    expect(recordLlmUsage).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      feature: "embeddings",
      model: "embed-test",
      inputTokens: 42,
      outputTokens: 0,
      inputRateUsdPerMillion: 0.02,
      outputRateUsdPerMillion: 0
    });
  });

  test("sends the model, bearer key and input truncated to 8000 characters", async () => {
    fetchMock.mockResolvedValue(reply({ data: [{ index: 0, embedding: vector(1) }] }));
    await createEmbedding("x".repeat(9000));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://embeddings.test/v1");
    expect(init.headers.Authorization).toBe("Bearer key");
    const body = JSON.parse(init.body) as { model: string; input: string[] };
    expect(body.model).toBe("embed-test");
    expect(body.input[0]?.length).toBe(8000);
  });

  test("rejects invalid inputs before calling the provider", async () => {
    await expect(createEmbeddings([])).rejects.toThrow("1 to 64 non-empty strings");
    await expect(createEmbeddings(["ok", "   "])).rejects.toThrow("1 to 64 non-empty strings");
    await expect(createEmbeddings(new Array<string>(65).fill("a"))).rejects.toThrow("1 to 64 non-empty strings");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fails on provider errors, wrong counts and wrong vector sizes", async () => {
    fetchMock.mockResolvedValue(reply({}, false, 500));
    await expect(createEmbeddings(["a"])).rejects.toThrow("returned 500");
    fetchMock.mockResolvedValue(reply({ data: [] }));
    await expect(createEmbeddings(["a"])).rejects.toThrow("unexpected vector count");
    fetchMock.mockResolvedValue(reply({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    await expect(createEmbeddings(["a"])).rejects.toThrow("invalid vector");
    fetchMock.mockResolvedValue(reply({ nope: true }));
    await expect(createEmbeddings(["a"])).rejects.toThrow("unexpected vector count");
  });
});

describe("embedding service circuit breaker", () => {
  const THRESHOLD = 5; // the default LLM_CIRCUIT_FAILURE_THRESHOLD (the env mock above sets none)

  beforeEach(() => {
    resetEmbeddingsCircuit();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("stops calling the provider after repeated 5xx answers", async () => {
    fetchMock.mockResolvedValue(reply({}, false, 503));
    for (let i = 0; i < THRESHOLD; i += 1) await expect(createEmbeddings(["a"])).rejects.toThrow("returned 503");
    await expect(createEmbeddings(["a"])).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD);
  });

  test("counts network failures as outage errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    for (let i = 0; i < THRESHOLD; i += 1) await expect(createEmbeddings(["a"])).rejects.toThrow("fetch failed");
    await expect(createEmbeddings(["a"])).rejects.toBeInstanceOf(CircuitOpenError);
  });

  test("does not trip on 4xx answers or on a bad vector count", async () => {
    fetchMock.mockResolvedValue(reply({}, false, 401));
    for (let i = 0; i < THRESHOLD + 1; i += 1) await expect(createEmbeddings(["a"])).rejects.toThrow("returned 401");
    fetchMock.mockResolvedValue(reply({ data: [] }));
    for (let i = 0; i < THRESHOLD + 1; i += 1) await expect(createEmbeddings(["a"])).rejects.toThrow("unexpected vector count");
    expect(fetchMock).toHaveBeenCalledTimes(2 * (THRESHOLD + 1));
  });

  test("does not count invalid caller input", async () => {
    for (let i = 0; i < THRESHOLD + 1; i += 1) await expect(createEmbeddings([])).rejects.toThrow("1 to 64");
    fetchMock.mockResolvedValue(reply({ data: [{ index: 0, embedding: vector(1) }] }));
    await expect(createEmbeddings(["a"])).resolves.toHaveLength(1);
  });
});

describe("embedding service without an API key", () => {
  test("returns null instead of calling the provider", async () => {
    const previous = env.EMBEDDINGS_API_KEY;
    env.EMBEDDINGS_API_KEY = undefined;
    try {
      expect(await createEmbedding("text")).toBeNull();
      expect(await createEmbeddings(["text"])).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      env.EMBEDDINGS_API_KEY = previous;
    }
  });
});
