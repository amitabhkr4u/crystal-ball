import type { NextFunction, Request, Response } from "express";

interface ErrorResult {
  status: number;
  code: string;
  message: string;
}

// The few properties we look at on a thrown value of unknown shape.
interface ErrorLike {
  type?: unknown;
  name?: unknown;
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

interface Rule {
  matches: (error: ErrorLike) => boolean;
  result: ErrorResult | ((error: ErrorLike) => ErrorResult);
}

const DEFAULT_ERROR: ErrorResult = {
  status: 500,
  code: "INTERNAL_ERROR",
  message: "Something went wrong. Please try again."
};

const DUPLICATE: ErrorResult = {
  status: 409,
  code: "DUPLICATE_RESOURCE",
  message: "A resource with these values already exists."
};

// Returns the status when it is an integer in the 4xx range.
function clientStatus(error: ErrorLike): number | undefined {
  const { status } = error;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500 ? status : undefined;
}

// Rules are checked in order; the first match wins.
const RULES: readonly Rule[] = [
  {
    matches: (e) => e.type === "entity.parse.failed",
    result: { status: 400, code: "INVALID_JSON", message: "Request body must contain valid JSON." }
  },
  {
    matches: (e) => e.type === "entity.too.large",
    result: { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." }
  },
  {
    matches: (e) => e.name === "ValidationError" || e.name === "CastError",
    result: { status: 400, code: "DATA_VALIDATION_ERROR", message: "Submitted data is invalid." }
  },
  { matches: (e) => e.code === 11000 || e.code === "P2002", result: DUPLICATE },
  {
    matches: (e) => e.code === "P2025",
    result: { status: 404, code: "RESOURCE_NOT_FOUND", message: "The requested resource was not found." }
  },
  {
    matches: (e) => e.code === "P2003",
    result: { status: 409, code: "RELATION_CONFLICT", message: "The operation conflicts with related records." }
  },
  {
    // A circuit breaker refused the call because the provider is down; do not retry immediately.
    matches: (e) => e.name === "CircuitOpenError" || e.code === "P1001" || e.code === "ECONNREFUSED",
    result: { status: 503, code: "DEPENDENCY_UNAVAILABLE", message: "A required service is temporarily unavailable." }
  },
  {
    matches: (e) => e.name === "APIConnectionTimeoutError" || e.name === "AbortError" || e.status === 408,
    result: { status: 504, code: "UPSTREAM_TIMEOUT", message: "An upstream service timed out." }
  },
  {
    matches: (e) => clientStatus(e) !== undefined,
    result: (e) => ({
      status: clientStatus(e) ?? 400,
      code: "REQUEST_ERROR",
      message: "The request could not be completed."
    })
  }
];

// Turns any thrown value into a safe JSON response.
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): Response {
  const requestId = req.id || "unknown";
  const like: ErrorLike = typeof error === "object" && error !== null ? error : {};
  const rule = RULES.find((candidate) => candidate.matches(like));
  const { status, code, message } = rule
    ? typeof rule.result === "function"
      ? rule.result(like)
      : rule.result
    : DEFAULT_ERROR;

  console.error("[api:error]", { requestId, code, status, message: like.message });
  return res.status(status).json({ error: { code, message, requestId } });
}
