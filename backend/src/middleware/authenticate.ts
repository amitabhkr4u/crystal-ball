import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../auth/tokens";
import { sendError } from "../utils/httpResponse";

// Checks the Bearer token and attaches its claims to the request.
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const token = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "")?.[1];
  if (!token) {
    sendError(res, 401, "UNAUTHENTICATED", "Bearer access token required");
    return;
  }
  try {
    req.auth = verifyAccessToken(token);
  } catch {
    sendError(res, 401, "INVALID_TOKEN", "Access token is invalid or expired");
    return;
  }
  next();
}
