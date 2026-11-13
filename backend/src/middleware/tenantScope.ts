import type { NextFunction, Request, Response } from "express";
import { sendError } from "../utils/httpResponse";

// Copies the tenant id from the verified token onto the request.
export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) {
    sendError(res, 403, "TENANT_REQUIRED", "Tenant context is required");
    return;
  }
  req.tenantId = tenantId;
  next();
}
