import bcrypt from "bcryptjs";
import { Router, type CookieOptions, type Request, type Response } from "express";
import type { Membership, User } from "@prisma/client";
import { z } from "zod";
import {
  issueAccessToken,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken
} from "../auth/tokens";
import { env } from "../config/env";
import { getPrisma } from "../db/postgres";
import { withTenantTransaction } from "../db/tenantTransaction";
import { sendError } from "../utils/httpResponse";
import { redisRateLimit } from "../middleware/redisRateLimit";

export const authRoutes: Router = Router();
const REFRESH_COOKIE = "cb_refresh";
const COOKIE_PATH = "/api/v1/auth";

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  tenantSlug: z.string().min(2).max(80)
});
const refreshSchema = z.object({ refreshToken: z.string().min(20).optional() });

let dummyHash: string | undefined;

// Returns a fake hash so unknown users take the same time as real ones.
function getDummyHash(): string {
  dummyHash ??= bcrypt.hashSync("not-a-real-password", 12);
  return dummyHash;
}

// Returns the base cookie settings for the refresh token.
function cookieOptions(): CookieOptions {
  return { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "strict", path: COOKIE_PATH };
}

// Stores the refresh token in an HttpOnly cookie.
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions(), maxAge: env.JWT_REFRESH_TTL_SECONDS * 1000 });
}

// Removes the refresh token cookie.
function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

// Reads the refresh token cookie; anything that is not a non-empty string counts as missing.
function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" && value ? value : undefined;
}

// Loads the user's membership for one tenant.
function findMembership(tenantId: string, userId: string): Promise<Membership | null> {
  return withTenantTransaction(tenantId, (tx) =>
    tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } } })
  );
}

// Builds the user object that is safe to send to the browser.
function publicUser(user: Pick<User, "id" | "email" | "fullName">, membership: Pick<Membership, "tenantId" | "role">) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    tenantId: membership.tenantId,
    role: membership.role
  };
}

// Builds the common token response body.
function tokenResponse(
  accessToken: string,
  user: Pick<User, "id" | "email" | "fullName">,
  membership: Pick<Membership, "tenantId" | "role">
) {
  return {
    data: {
      accessToken,
      tokenType: "Bearer",
      expiresIn: env.JWT_ACCESS_TTL,
      user: publicUser(user, membership)
    }
  };
}

// Logs a user in and issues access and refresh tokens.
authRoutes.post("/login", redisRateLimit({ max: 10, windowMs: 15 * 60 * 1000, prefix: "rate:auth-login" }), async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid login request");
  const { email, password, tenantSlug } = parsed.data;
  try {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    const membership = user && tenant ? await findMembership(tenant.id, user.id) : null;
    const passwordMatches = await bcrypt.compare(password, user ? user.passwordHash : getDummyHash());

    if (!user || !user.isActive || !membership || !passwordMatches) {
      return sendError(res, 401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }

    const identity = { id: user.id, tenantId: membership.tenantId, roles: [membership.role] };
    setRefreshCookie(res, await issueRefreshToken(identity));
    return res.json(tokenResponse(issueAccessToken(identity), user, membership));
  } catch (error) {
    return next(error);
  }
});

// Swaps a one-time refresh token for a new token pair.
authRoutes.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid refresh request");
  const token = readRefreshCookie(req) || parsed.data.refreshToken;
  if (!token) return sendError(res, 401, "INVALID_REFRESH_TOKEN", "Refresh token is missing");

  try {
    const rotated = await rotateRefreshToken(token);
    const user = await getPrisma().user.findUnique({ where: { id: rotated.userId } });
    const membership = user ? await findMembership(rotated.tenantId, user.id) : null;

    if (!user || !user.isActive || !membership) {
      await revokeRefreshToken(rotated.refreshToken);
      clearRefreshCookie(res);
      return sendError(res, 401, "INVALID_REFRESH_TOKEN", "The account is no longer active");
    }

    setRefreshCookie(res, rotated.refreshToken);
    return res.json(tokenResponse(rotated.accessToken, user, membership));
  } catch {
    return sendError(res, 401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid, expired, or already used");
  }
});

// Revokes the refresh token and clears the cookie.
authRoutes.post("/logout", async (req, res) => {
  const token = readRefreshCookie(req);
  if (token) {
    try {
      await revokeRefreshToken(token);
    } catch {
      // Logout must still succeed when the token is already invalid or Redis is down.
    }
  }
  clearRefreshCookie(res);
  return res.status(204).end();
});
