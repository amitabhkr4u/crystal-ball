import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { issueAccessToken, issueRefreshToken, revokeRefreshToken, rotateRefreshToken, verifyAccessToken } from "../../src/auth/tokens";
import { env } from "../../src/config/env";
import { getRedis } from "../../src/db/redis";

// Keys are generated inside the factory because jest.mock is hoisted above imports.
jest.mock("../../src/config/env", () => {
  const { generateKeyPairSync: generate } = jest.requireActual<typeof import("node:crypto")>("node:crypto");
  const keys = generate("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  return {
    env: {
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_PUBLIC_KEY: keys.publicKey,
      JWT_ACCESS_TTL: "15m",
      JWT_REFRESH_TTL_SECONDS: 3600
    }
  };
});
jest.mock("../../src/db/redis", () => ({ getRedis: jest.fn() }));

// A tiny in-memory stand-in for the Redis commands the token code uses.
class FakeRedis {
  readonly store = new Map<string, string>();
  async set(key: string, value: string, ..._options: Array<string | number>): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }
  async call(_command: string, key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

const user = { id: "user-1", tenantId: "tenant-1", roles: ["admin", "operator"] };

describe("access tokens", () => {
  it("round-trips the user, tenant and roles", () => {
    const claims = verifyAccessToken(issueAccessToken(user));
    expect(claims).toMatchObject({ sub: "user-1", tenantId: "tenant-1", roles: ["admin", "operator"] });
  });

  it("rejects a token signed with a different key", () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    const forged = jwt.sign({ sub: "user-1", tenantId: "tenant-1", roles: ["admin"] }, other.privateKey, {
      algorithm: "RS256",
      issuer: "crystal-ball-api",
      audience: "crystal-ball-app"
    });
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it("rejects a validly signed token whose claims are the wrong shape", () => {
    const wrongShape = jwt.sign({ sub: "user-1" }, env.JWT_PRIVATE_KEY ?? "", {
      algorithm: "RS256",
      issuer: "crystal-ball-api",
      audience: "crystal-ball-app"
    });
    expect(() => verifyAccessToken(wrongShape)).toThrow("INVALID_ACCESS_TOKEN_CLAIMS");
  });
});

describe("refresh tokens", () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
    jest.mocked(getRedis).mockReturnValue(redis as unknown as ReturnType<typeof getRedis>);
  });

  it("is not accepted as an access token", async () => {
    const refresh = await issueRefreshToken(user);
    expect(() => verifyAccessToken(refresh)).toThrow();
  });

  it("rotates once and returns a working new pair", async () => {
    const refresh = await issueRefreshToken(user);
    const pair = await rotateRefreshToken(refresh);
    expect(pair).toMatchObject({ userId: "user-1", tenantId: "tenant-1" });
    expect(verifyAccessToken(pair.accessToken).roles).toEqual(["admin", "operator"]);
    expect(pair.refreshToken).not.toBe(refresh);
  });

  it("refuses to use the same refresh token twice", async () => {
    const refresh = await issueRefreshToken(user);
    await rotateRefreshToken(refresh);
    await expect(rotateRefreshToken(refresh)).rejects.toThrow("REFRESH_TOKEN_REUSED_OR_EXPIRED");
  });

  it("revokes a session exactly once", async () => {
    const refresh = await issueRefreshToken(user);
    await expect(revokeRefreshToken(refresh)).resolves.toBe(true);
    await expect(revokeRefreshToken(refresh)).resolves.toBe(false);
  });

  it("rejects an access token presented as a refresh token", async () => {
    await expect(rotateRefreshToken(issueAccessToken(user))).rejects.toThrow();
  });
});
