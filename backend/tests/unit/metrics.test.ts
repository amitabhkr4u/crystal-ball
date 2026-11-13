import { llmFallbacks, llmLatency, llmRequests, llmTokens, register } from "../../src/observability/metrics";

describe("LLM metrics", () => {
  test("registers the LLM counters and histogram on the app registry", async () => {
    llmRequests.inc({ feature: "alert", model: "test-model", outcome: "ok" });
    llmTokens.inc({ feature: "alert", model: "test-model", direction: "input" }, 42);
    llmFallbacks.inc({ feature: "alert", reason: "timeout" });
    llmLatency.observe({ feature: "alert", model: "test-model" }, 0.3);

    const text = await register.metrics();
    expect(text).toContain("crystal_ball_llm_requests_total");
    expect(text).toContain("crystal_ball_llm_tokens_total");
    expect(text).toContain("crystal_ball_llm_fallback_total");
    expect(text).toContain("crystal_ball_llm_request_duration_seconds_bucket");
    expect(text).toContain('le="0.5"');
    expect(text).toContain('reason="timeout"');
  });

  test("includes default process metrics", async () => {
    expect(await register.metrics()).toContain("process_cpu_user_seconds_total");
  });
});
