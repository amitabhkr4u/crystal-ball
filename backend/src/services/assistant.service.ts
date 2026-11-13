import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env";
import { approvals, policy } from "../data/approvals";
import { approvalReviewPrompt as approvalPrompt } from "../prompts/approvalReview.v1";
import { getAnthropicClient } from "./llmClient";
import { llmCircuit } from "./llmCircuit";
import { recordLlmUsage } from "./llmCost.service";
import { llmLatency, llmRequests, llmTokens } from "../observability/metrics";

const language = z.string().trim().min(2).max(40).default("English");
const message = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) });

export const schemas = {
  summary: z.object({ language }),
  greeting: z.object({ language }),
  talk: z.object({
    language,
    messages: z
      .array(message)
      .min(1)
      .max(20)
      .refine((items) => items.at(-1)?.role === "user")
  }),
  help: z.object({ language, question: z.string().trim().min(3).max(500) }),
  teach: z.object({ language, approvalId: z.string().optional(), messages: z.array(message).max(20).default([]) })
};

export type AssistantPath = keyof typeof schemas;
export type AssistantBody = z.infer<(typeof schemas)[AssistantPath]>;

export interface AssistantTriage {
  headline: string;
  items: { id: string; priority: "high" | "medium" | "low"; reason: string }[];
}

export interface AssistantFallback {
  text: string;
  triage?: AssistantTriage;
}

const TYPE_ORDER: Record<(typeof approvals)[number]["type"], number> = { PDF: 0, Folder: 1, Video: 2, Image: 3 };

// Builds a built-in answer when the AI is unavailable.
export function createFallback(path: AssistantPath, body: AssistantBody): AssistantFallback {
  const sorted = [...approvals].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);

  if (path === "summary") {
    return {
      text: `${sorted.length} approvals are waiting. Review Safety Equipment & Sensor Specs first, followed by Site Patrol Onboarding & Checklists, the drone patrol demo, and the spatial zone layout.`,
      triage: {
        headline: `${sorted.length} approvals waiting`,
        items: sorted.map((item) => ({
          id: item.id,
          priority: item.type === "PDF" ? "high" : item.type === "Folder" ? "medium" : "low",
          reason: `Review ${item.type.toLowerCase()} according to the approval policy.`
        }))
      }
    };
  }

  if (path === "greeting")
    return { text: `Good evening. There are ${approvals.length} approvals waiting for your review.` };
  if (path === "help") {
    const question = ("question" in body ? body.question : "").toLowerCase();
    const match = policy
      .split("\n")
      .find((line) => question.split(/\s+/).some((word) => word.length > 3 && line.toLowerCase().includes(word)));
    return {
      text:
        match || "I could not find a matching policy section. Please check the approval policy or ask the Safety Lead."
    };
  }
  if (path === "teach")
    return {
      text: "Open the approval item and review the complete content. Check it against the file-type checklist. Approve only when every check passes; request changes for incomplete content; reject incorrect, outdated, or unsafe content with a clear reason. Escalate safety concerns before making a decision."
    };
  return {
    text: "I can help prioritize approvals, explain the review policy, and guide you through the queue. Safety and sensor documents should be reviewed first."
  };
}

// Builds the chat messages the model receives for one assistant path.
function buildMessages(path: AssistantPath, body: AssistantBody): Anthropic.MessageParam[] {
  const history = "messages" in body ? body.messages : [];
  if (path === "talk") return history;
  if (path === "teach") {
    return history.length
      ? history
      : [{ role: "user", content: "Teach me the approval review workflow step by step." }];
  }
  if (path === "help") return [{ role: "user", content: "question" in body ? body.question : "" }];
  return [{ role: "user", content: path === "summary" ? "Summarize and prioritize the queue." : "Greet me." }];
}

// Streams the model answer token by token.
export async function* streamModelResponse(path: AssistantPath, body: AssistantBody, tenantId = "system"): AsyncGenerator<string, void, undefined> {
  const client = getAnthropicClient();
  if (!client) throw new Error("NO_API_KEY");
  const prompts: Record<AssistantPath, string> = {
    summary: approvalPrompt.system.summary(policy, approvals),
    greeting: approvalPrompt.system.greeting(policy, approvals),
    help: approvalPrompt.system.help(policy),
    teach: approvalPrompt.system.teach(policy),
    talk: approvalPrompt.system.talk(policy, approvals)
  };

  // The breaker stops new streams while the provider is down; the controller then uses its built-in answer.
  const startedAt = Date.now();
  const events = llmCircuit.execStream(() =>
    client.messages.stream({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 700,
      system: `${prompts[path]}\nRespond in ${body.language || "English"}.`,
      messages: buildMessages(path, body)
    })
  );

  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for await (const event of events) {
      if (event.type === "message_start") inputTokens = event.message.usage.input_tokens;
      if (event.type === "message_delta") outputTokens = event.usage.output_tokens;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
    }
  } finally {
    if (inputTokens || outputTokens) {
      const feature = `assistant_${path}`;
      llmRequests.inc({ feature, model: env.ANTHROPIC_MODEL, outcome: "success" });
      llmLatency.observe({ feature, model: env.ANTHROPIC_MODEL }, (Date.now() - startedAt) / 1000);
      llmTokens.inc({ feature, model: env.ANTHROPIC_MODEL, direction: "input" }, inputTokens);
      llmTokens.inc({ feature, model: env.ANTHROPIC_MODEL, direction: "output" }, outputTokens);
      try {
        await recordLlmUsage({ tenantId, feature, model: env.ANTHROPIC_MODEL, inputTokens, outputTokens });
      } catch (error: unknown) {
        console.error("[llm-cost] assistant usage persistence failed:", error instanceof Error ? error.message : "unknown error");
      }
    }
  }
}

export function hasClient(): boolean {
  return Boolean(getAnthropicClient());
}

export { approvals };
export const promptVersion = approvalPrompt.version;
