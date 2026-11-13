import type { AccessClaims } from "../auth/tokens";

// Adds the fields our middleware sets on every Express request.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Unique id assigned by the request-id middleware. */
      id: string;
      /** Verified access-token claims, set by `authenticate`. */
      auth?: AccessClaims;
      /** Tenant id copied from the token by `requireTenant`. */
      tenantId?: string;
    }
  }
}

export {};
