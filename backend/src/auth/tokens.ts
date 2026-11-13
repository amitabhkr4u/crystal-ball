import { randomUUID } from "node:crypto";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env";
import { getRedis } from "../db/redis";

const ISSUER = "crystal-ball-api";
const ACCESS_AUDIENCE = "crystal-ball-app";
const REFRESH_AUDIENCE = "crystal-ball-refresh";

/** The user fields a token is issued for. */
export interface TokenSubject {
  id: string | number;
  tenantId: string | number;
  roles?: readonly string[];
}

const accessClaimsSchema = z
  .object({
    sub: z.string().min(1),
    tenantId: z.string().min(1),
    roles: z.array(z.string().min(1).max(80))
  })
  .passthrough();

const refreshClaimsSchema = z
  .object({
    sub: z.string().min(1),
    tenantId: z.string().min(1),
    jti: z.string().min(1),
    type: z.literal("refresh")
  })
  .passthrough();

// What we keep in Redis for each refresh token.
const refreshSessionSchema = z.object({
  userId: z.string(),
  tenantId: z.string(),
  roles: z.array(z.string())
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;
export type RefreshClaims = z.infer<typeof refreshClaimsSchema>;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
}

// Reads a PEM key from env and restores line breaks.
function pem(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value.replace(/\\n/g, "\n");
}

const privateKey = (): string => pem(env.JWT_PRIVATE_KEY, "JWT_PRIVATE_KEY");
const publicKey = (): string => pem(env.JWT_PUBLIC_KEY, "JWT_PUBLIC_KEY");

// Creates a short-lived RS256 access token.
export function issueAccessToken(user: TokenSubject): string {
  const claims = { sub: String(user.id), tenantId: String(user.tenantId), roles: [...(user.roles ?? [])] };
  return jwt.sign(claims, privateKey(), {
    algorithm: "RS256",
    // JWT_ACCESS_TTL is checked against the "15m" / "2h" shape in config/env.ts.
    expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"],
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE
  });
}

// Creates a refresh token and saves its session in Redis.
export async function issueRefreshToken(user: TokenSubject): Promise<string> {
  const jti = randomUUID();
  const token = jwt.sign(
    { sub: String(user.id), tenantId: String(user.tenantId), jti, type: "refresh" },
    privateKey(),
    { algorithm: "RS256", expiresIn: env.JWT_REFRESH_TTL_SECONDS, issuer: ISSUER, audience: REFRESH_AUDIENCE }
  );
  const session = { userId: String(user.id), tenantId: String(user.tenantId), roles: [...(user.roles ?? [])] };
  await getRedis().set(`refresh:${jti}`, JSON.stringify(session), "EX", env.JWT_REFRESH_TTL_SECONDS, "NX");
  return token;
}

// Verifies an access token and checks its claim shapes.
export function verifyAccessToken(token: string): AccessClaims {
  const claims = jwt.verify(token, publicKey(), {
    algorithms: ["RS256"],
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE
  });
  const parsed = accessClaimsSchema.safeParse(claims);
  if (!parsed.success) throw new Error("INVALID_ACCESS_TOKEN_CLAIMS");
  return parsed.data;
}

// Verifies a refresh token signature and returns its raw claims.
function verifyRefreshSignature(token: string): JwtPayload | string {
  return jwt.verify(token, publicKey(), {
    algorithms: ["RS256"],
    issuer: ISSUER,
    audience: REFRESH_AUDIENCE
  });
}

// Deletes a refresh session so the token cannot be used again.
export async function revokeRefreshToken(token: string): Promise<boolean> {
  const claims = refreshClaimsSchema.safeParse(verifyRefreshSignature(token));
  if (!claims.success) return false;
  return (await getRedis().del(`refresh:${claims.data.jti}`)) === 1;
}

// Uses a refresh token once and returns a fresh token pair.
export async function rotateRefreshToken(token: string): Promise<TokenPair> {
  const claims = refreshClaimsSchema.safeParse(verifyRefreshSignature(token));
  if (!claims.success) throw new Error("INVALID_REFRESH_TOKEN");
  const { jti, sub, tenantId } = claims.data;

  // GETDEL makes the token single-use even when two requests race.
  const stored = await getRedis().call("GETDEL", `refresh:${jti}`);
  if (typeof stored !== "string" || !stored) throw new Error("REFRESH_TOKEN_REUSED_OR_EXPIRED");

  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    throw new Error("INVALID_REFRESH_SESSION");
  }
  const session = refreshSessionSchema.safeParse(raw);
  if (!session.success || session.data.userId !== sub || session.data.tenantId !== tenantId) {
    throw new Error("INVALID_REFRESH_SESSION");
  }

  const identity: TokenSubject = {
    id: session.data.userId,
    tenantId: session.data.tenantId,
    roles: session.data.roles
  };
  return {
    accessToken: issueAccessToken(identity),
    refreshToken: await issueRefreshToken(identity),
    userId: session.data.userId,
    tenantId: session.data.tenantId
  };
}
