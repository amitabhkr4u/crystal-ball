import type { Request } from "express";
import type { AccessClaims } from "../auth/tokens";

// Returns the tenant id that `requireTenant` copied onto the request.
export function getTenantId(req: Request): string {
  if (!req.tenantId) throw new Error("tenantId is missing; add requireTenant before this handler");
  return req.tenantId;
}

// Returns the verified token claims that `authenticate` attached to the request.
export function getAuth(req: Request): AccessClaims {
  if (!req.auth) throw new Error("auth is missing; add authenticate before this handler");
  return req.auth;
}
