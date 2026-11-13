import { env } from "../config/env";
import { llmCircuitState } from "../observability/metrics";
import { createCircuitBreaker, type CircuitBreaker, type CircuitState } from "../utils/circuitBreaker";

const STATE_VALUE: Record<CircuitState, number> = { closed: 0, half_open: 1, open: 2 };

// Builds a circuit breaker for one external AI provider, with the shared thresholds from the
// environment, a Prometheus gauge and a log line on every state change.
export function createProviderCircuit(name: string, isFailure: (error: unknown) => boolean): CircuitBreaker {
  llmCircuitState.set({ name }, STATE_VALUE.closed);
  return createCircuitBreaker({
    name,
    failureThreshold: env.LLM_CIRCUIT_FAILURE_THRESHOLD,
    cooldownMs: env.LLM_CIRCUIT_COOLDOWN_MS,
    isFailure,
    onStateChange: (state, previous) => {
      llmCircuitState.set({ name }, STATE_VALUE[state]);
      console.warn(`[ai] ${name} circuit ${previous} -> ${state}`);
    }
  });
}
