import Anthropic from "@anthropic-ai/sdk";
import {
  createFallback,
  hasClient,
  promptVersion,
  schemas,
  streamModelResponse
} from "../../src/services/assistant.service";
import { getAnthropicClient } from "../../src/services/llmClient";
import { llmCircuit, resetLlmCircuit } from "../../src/services/llmCircuit";
import { CircuitOpenError } from "../../src/utils/circuitBreaker";

jest.mock("../../src/config/env", () => ({ env: { ANTHROPIC_MODEL: "test-model" } }));
jest.mock("../../src/services/llmClient", () => ({ getAnthropicClient: jest.fn() }));

const clientMock = getAnthropicClient as unknown as jest.Mock;
const stream = jest.fn();

async function* events(...texts: string[]): AsyncGenerator<unknown> {
  yield { type: "message_start" };
  for (const text of texts) yield { type: "content_block_delta", delta: { type: "text_delta", text } };
  yield { type: "message_stop" };
}

async function collect(iterator: AsyncGenerator<string, void, undefined>): Promise<string[]> {
  const out: string[] = [];
  for await (const token of iterator) out.push(token);
  return out;
}

describe("assistant request schemas", () => {
  test("default the language and trim inputs", () => {
    expect(schemas.summary.parse({})).toEqual({ language: "English" });
    expect(schemas.help.parse({ question: "  how to reject?  " }).question).toBe("how to reject?");
  });

  test("talk requires the last message to come from the user", () => {
    const user = { role: "user", content: "hi" };
    const assistant = { role: "assistant", content: "hello" };
    expect(schemas.talk.safeParse({ messages: [user] }).success).toBe(true);
    expect(schemas.talk.safeParse({ messages: [user, assistant] }).success).toBe(false);
    expect(schemas.talk.safeParse({ messages: [] }).success).toBe(false);
  });

  test("help rejects very short questions", () => {
    expect(schemas.help.safeParse({ question: "hi" }).success).toBe(false);
  });
});

describe("assistant fallback answers", () => {
  test("summary lists the PDF first with high priority", () => {
    const result = createFallback("summary", { language: "English" });
    expect(result.triage?.items[0]).toMatchObject({ id: "APR-003", priority: "high" });
    expect(result.triage?.items).toHaveLength(4);
  });

  test("help answers from the matching policy line or says it cannot", () => {
    expect(createFallback("help", { language: "English", question: "when should I escalate" }).text).toContain("Safety Lead");
    expect(createFallback("help", { language: "English", question: "xyz" }).text).toContain("could not find");
  });

  test("greeting reports the number of waiting approvals", () => {
    expect(createFallback("greeting", { language: "English" }).text).toContain("4 approvals");
  });
});

describe("assistant streaming", () => {
  beforeEach(() => {
    resetLlmCircuit();
    stream.mockReset();
    clientMock.mockReturnValue({ messages: { stream } });
  });

  test("reports whether a client is configured", () => {
    expect(hasClient()).toBe(true);
    clientMock.mockReturnValue(null);
    expect(hasClient()).toBe(false);
    expect(promptVersion).toBe("approval-review.v1");
  });

  test("yields only text deltas and asks for the requested language", async () => {
    stream.mockReturnValue(events("Hel", "lo"));
    const tokens = await collect(streamModelResponse("greeting", { language: "Hindi" }));
    expect(tokens).toEqual(["Hel", "lo"]);
    const params = stream.mock.calls[0]?.[0] as { model: string; system: string; messages: unknown[] };
    expect(params.model).toBe("test-model");
    expect(params.system).toContain("Respond in Hindi.");
    expect(params.messages).toEqual([{ role: "user", content: "Greet me." }]);
  });

  test("teach starts a default lesson when there is no history", async () => {
    stream.mockReturnValue(events("ok"));
    await collect(streamModelResponse("teach", { language: "English", messages: [] }));
    const params = stream.mock.calls[0]?.[0] as { messages: { content: string }[] };
    expect(params.messages[0]?.content).toContain("Teach me the approval review workflow");
  });

  test("throws NO_API_KEY without a client", async () => {
    clientMock.mockReturnValue(null);
    await expect(collect(streamModelResponse("greeting", { language: "English" }))).rejects.toThrow("NO_API_KEY");
  });

  describe("circuit breaker", () => {
    const THRESHOLD = 5; // the default LLM_CIRCUIT_FAILURE_THRESHOLD (the env mock above sets none)
    const greeting = { language: "English" } as const;

    async function* dies(): AsyncGenerator<unknown> {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } };
      throw new Anthropic.APIConnectionError({ message: "connection reset" });
    }

    test("stops opening streams after repeated outage failures", async () => {
      stream.mockImplementation(() => {
        throw new Anthropic.APIConnectionTimeoutError();
      });
      for (let i = 0; i < THRESHOLD; i += 1) {
        await expect(collect(streamModelResponse("greeting", greeting))).rejects.toBeInstanceOf(
          Anthropic.APIConnectionTimeoutError
        );
      }
      await expect(collect(streamModelResponse("greeting", greeting))).rejects.toBeInstanceOf(CircuitOpenError);
      expect(stream).toHaveBeenCalledTimes(THRESHOLD);
    });

    test("counts a stream that dies mid-answer as a failure", async () => {
      stream.mockImplementation(() => dies());
      for (let i = 0; i < THRESHOLD; i += 1) await collect(streamModelResponse("greeting", greeting)).catch(() => []);
      expect(llmCircuit.state).toBe("open");
    });

    test("does not open the circuit when the client disconnects mid-stream", async () => {
      stream.mockImplementation(() => events("one", "two"));
      for (let i = 0; i < THRESHOLD + 1; i += 1) {
        for await (const token of streamModelResponse("greeting", greeting)) {
          expect(token).toBe("one");
          break;
        }
      }
      expect(llmCircuit.state).toBe("closed");
      expect(stream).toHaveBeenCalledTimes(THRESHOLD + 1);
    });
  });
});
