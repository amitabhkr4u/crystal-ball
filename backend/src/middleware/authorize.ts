import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sendError } from "../utils/httpResponse";

// Builds a guard that allows only the listed roles.
export function requireRole(...allowedRoles: string[]): RequestHandler {
  // Blocks the request when the user has none of the allowed roles.
  return function roleGuard(req: Request, res: Response, next: NextFunction): void {
    const roles = req.auth?.roles ?? [];
    if (!allowedRoles.some((role) => roles.includes(role))) {
      sendError(res, 403, "FORBIDDEN", "Your role does not allow this operation.");
      return;
    }
    next();
  };
}
