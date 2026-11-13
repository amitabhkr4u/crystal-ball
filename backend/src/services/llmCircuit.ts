import Anthropic from "@anthropic-ai/sdk";
import { createProviderCircuit } from "./providerCircuit";

// True when the error looks like an outage of the LLM service (timeout, network, 408, 429, 5xx).
// Client errors such as 400 or 401 mean the service answered, so they do not count.
// Unknown errors count, because we cannot tell that the service is healthy.
export function isLlmInfraFailure(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true; // includes connection timeouts
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof Anthropic.APIError) {
    const { status } = error;
    return status === undefined || status === 408 || status === 429 || status >= 500;
  }
  return true;
}

// One breaker for every call to the Anthropic API, so a provider outage is detected once.
export const llmCircuit = createProviderCircuit("anthropic", isLlmInfraFailure);

// Closes the circuit; used by tests so one test's failures do not leak into the next.
export function resetLlmCircuit(): void {
  llmCircuit.reset();
}
