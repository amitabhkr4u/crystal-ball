import { parseEnv } from "../../src/config/env";

describe("parseEnv", () => {
  it("fills in safe defaults for an empty environment", () => {
    const env = parseEnv({});
    expect(env).toMatchObject({
      NODE_ENV: "development",
      PORT: 4000,
      LLM_TIMEOUT_MS: 8000,
      LLM_CIRCUIT_FAILURE_THRESHOLD: 5,
      LLM_CIRCUIT_COOLDOWN_MS: 30000,
      JWT_ACCESS_TTL: "15m",
      AI_QUEUE_NAME: "ai-decisions"
    });
  });

  it("turns numeric strings into numbers", () => {
    expect(parseEnv({ PORT: "5050", MYSQL_POOL_LIMIT: "25" })).toMatchObject({ PORT: 5050, MYSQL_POOL_LIMIT: 25 });
  });

  it("treats an empty optional URL as unset", () => {
    const env = parseEnv({ ONCALL_WEBHOOK_URL: "", S3_ENDPOINT: "" });
    expect(env.ONCALL_WEBHOOK_URL).toBeUndefined();
    expect(env.S3_ENDPOINT).toBeUndefined();
  });

  it.each([
    [{ NODE_ENV: "staging" }],
    [{ PORT: "0" }],
    [{ MYSQL_POOL_LIMIT: "500" }],
    [{ ONCALL_WEBHOOK_URL: "not-a-url" }],
    [{ JWT_ACCESS_TTL: "fifteen minutes" }],
    [{ LLM_CIRCUIT_FAILURE_THRESHOLD: "0" }],
    [{ LLM_CIRCUIT_COOLDOWN_MS: "-1" }]
  ])("rejects %j", (source) => {
    expect(() => parseEnv(source)).toThrow("Invalid environment");
  });
});
