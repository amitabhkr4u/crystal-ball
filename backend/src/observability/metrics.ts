import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const register = new Registry();
collectDefaultMetrics({ register });

export const llmRequests = new Counter({
  name: "crystal_ball_llm_requests_total",
  help: "LLM requests by feature, model and outcome",
  labelNames: ["feature", "model", "outcome"],
  registers: [register]
});

export const llmTokens = new Counter({
  name: "crystal_ball_llm_tokens_total",
  help: "LLM tokens consumed by feature, model and direction",
  labelNames: ["feature", "model", "direction"],
  registers: [register]
});

export const llmLatency = new Histogram({
  name: "crystal_ball_llm_request_duration_seconds",
  help: "LLM request duration in seconds",
  labelNames: ["feature", "model"],
  buckets: [0.25, 0.5, 1, 2, 4, 8, 12, 20],
  registers: [register]
});

export const llmFallbacks = new Counter({
  name: "crystal_ball_llm_fallback_total",
  help: "Deterministic fallbacks by reason",
  labelNames: ["feature", "reason"],
  registers: [register]
});

export const llmCircuitState = new Gauge({
  name: "crystal_ball_llm_circuit_state",
  help: "LLM circuit breaker state: 0 closed, 1 half-open, 2 open",
  labelNames: ["name"],
  registers: [register]
});

export const llmCostUsd = new Counter({
  name: "crystal_ball_llm_cost_usd_total",
  help: "Estimated LLM spend in USD using configured per-million-token rates",
  labelNames: ["feature", "model"],
  registers: [register]
});

export const sensorAnomalies = new Counter({
  name: "crystal_ball_sensor_anomalies_total",
  help: "Numeric sensor anomalies detected against recent history",
  labelNames: ["direction"],
  registers: [register]
});
