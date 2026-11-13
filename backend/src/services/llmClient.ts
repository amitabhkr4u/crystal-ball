import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";

let client: Anthropic | undefined;

// Returns the shared Anthropic client, or null without an API key.
export function getAnthropicClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: env.LLM_TIMEOUT_MS, maxRetries: 1 });
  }
  return client;
}
