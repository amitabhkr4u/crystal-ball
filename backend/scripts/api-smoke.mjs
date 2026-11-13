const baseUrl = (process.env.API_BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const checks = [];
async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => null);
  checks.push({ path, status: response.status });
  return { response, body };
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const health = await call("/api/health");
assert(health.response.ok && health.body?.ok === true, "health check failed");
const ready = await call("/api/ready");
assert(ready.response.ok, "readiness check failed");
const openapi = await call("/api/openapi.json");
assert(openapi.response.ok && openapi.body?.paths, "OpenAPI document unavailable");
const docs = await fetch(`${baseUrl}/api/docs/`);
assert(docs.ok, "Swagger UI unavailable");
checks.push({ path: "/api/docs/", status: docs.status });

const guarded = await call("/api/v1/usage/llm/daily");
assert(guarded.response.status === 401, "usage endpoint must reject unauthenticated requests");

  const assistant = await fetch(`${baseUrl}/api/ai/summary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language: "English" })
  });
  const assistantStream = await assistant.text();
  checks.push({ path: "/api/ai/summary", status: assistant.status });
  assert(assistant.ok && assistantStream.includes("event: done") && assistantStream.includes("event: token"), "assistant summary stream failed");

const { SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_TENANT_SLUG } = process.env;
if (SMOKE_EMAIL && SMOKE_PASSWORD && SMOKE_TENANT_SLUG) {
  const login = await call("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: SMOKE_EMAIL, password: SMOKE_PASSWORD, tenantSlug: SMOKE_TENANT_SLUG })
  });
  assert(login.response.ok && login.body?.data?.accessToken, "smoke login failed");
  const token = login.body.data.accessToken;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const usage = await call("/api/v1/usage/llm/daily", { headers });
  assert(usage.response.ok && usage.body?.data?.day, "tenant LLM usage endpoint failed");

  const alertId = `smoke-${Date.now()}`;
  const classify = await call("/api/v1/alerts/classify", {
    method: "POST",
    headers,
    body: JSON.stringify({
      alertId, siteId: "smoke-site", sensorId: "smoke-sensor", severity: "P2",
      occurredAt: new Date().toISOString(), payload: { smokeLevel: 0.12, temperatureC: 22 }
    })
  });
  assert(classify.response.status === 202, "alert classification was not queued");

  let acknowledged = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await call(`/api/v1/alerts/${encodeURIComponent(alertId)}/acknowledge`, {
      method: "POST", headers, body: "{}"
    });
    if (result.response.ok) { acknowledged = true; break; }
    if (![409, 404].includes(result.response.status)) {
      throw new Error(`acknowledge flow failed with HTTP ${result.response.status}`);
    }
  }
  assert(acknowledged, "alert was queued but not classified/acknowledged within 30 seconds");
} else {
  console.log("Authenticated journey skipped: set SMOKE_EMAIL, SMOKE_PASSWORD and SMOKE_TENANT_SLUG.");
}

console.log(JSON.stringify({ ok: true, checks }, null, 2));
