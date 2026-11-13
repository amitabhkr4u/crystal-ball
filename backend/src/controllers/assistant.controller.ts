import Anthropic from "@anthropic-ai/sdk";
import type { Request, Response } from "express";
import { env } from "../config/env";
import { llmFallbacks, llmRequests } from "../observability/metrics";
import type { FallbackReason } from "../services/aiDecision.service";
import {
  createFallback,
  hasClient,
  promptVersion,
  schemas,
  streamModelResponse,
  type AssistantBody,
  type AssistantPath
} from "../services/assistant.service";
import { CircuitOpenError } from "../utils/circuitBreaker";
import { errorMessage } from "../utils/errors";
import { sendError } from "../utils/httpResponse";

// Checks that the path names a known assistant action.
function isAssistantPath(value: string | undefined): value is AssistantPath {
  return value !== undefined && Object.hasOwn(schemas, value);
}

// Writes one server-sent event to the response.
function writeEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Picks the fallback reason from the error type.
function fallbackReason(error: unknown): FallbackReason {
  if (error instanceof CircuitOpenError) return "circuit_open";
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "llm_timeout";
  if (error instanceof Error && error.name === "AbortError") return "llm_timeout";
  return "llm_unavailable";
}

// Counts the fallback and sends the built-in answer.
function sendFallback(res: Response, path: AssistantPath, body: AssistantBody, reason: FallbackReason): void {
  const feature = `assistant_${path}`;
  if (reason !== "no_api_key") llmRequests.inc({ feature, model: env.ANTHROPIC_MODEL, outcome: "fallback" });
  llmFallbacks.inc({ feature, reason });
  const answer = createFallback(path, body);
  writeEvent(res, "token", { text: answer.text });
  if (answer.triage) writeEvent(res, "triage", answer.triage);
  writeEvent(res, "done", { fallback: true, reason, promptVersion });
}

// Streams an assistant answer as server-sent events.
export async function streamAssistant(req: Request, res: Response): Promise<void> {
  const path = req.params.path;
  if (!isAssistantPath(path)) {
    sendError(res, 404, "NOT_FOUND", "Unknown assistant action.");
    return;
  }

  const parsed = schemas[path].safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "VALIDATION_ERROR", "Invalid assistant request", parsed.error.issues);
    return;
  }
  const body: AssistantBody = parsed.data;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  if (!hasClient()) {
    sendFallback(res, path, body, "no_api_key");
    res.end();
    return;
  }

  let streamed = false;
  try {
    for await (const token of streamModelResponse(path, body)) {
      if (res.destroyed) break;
      streamed = true;
      writeEvent(res, "token", { text: token });
    }
    if (!res.destroyed) writeEvent(res, "done", { fallback: false, promptVersion });
  } catch (error: unknown) {
    console.warn("[ai] assistant stream failed:", errorMessage(error));
    if (!res.destroyed) {
      if (streamed) {
        writeEvent(res, "error", {
          code: "STREAM_INTERRUPTED",
          message: "The answer was interrupted. Please try again."
        });
      } else {
        sendFallback(res, path, body, fallbackReason(error));
      }
    }
  }
  res.end();
}