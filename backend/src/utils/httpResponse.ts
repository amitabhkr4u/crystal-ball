import type { Response } from "express";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

// Sends the standard JSON error body used by every route.
export function sendError(res: Response, status: number, code: string, message: string, details?: unknown): Response {
  const error: ApiErrorBody = { code, message };
  if (details) error.details = details;
  return res.status(status).json({ error });
}
