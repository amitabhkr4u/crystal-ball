import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../lib/api";
import { msUntilRefresh, tokenExpiryMs, useAuthStore } from "../../store/authStore";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, refreshSession: vi.fn(), loginUser: vi.fn(), logoutUser: vi.fn() };
});

const refreshSession = vi.mocked(api.refreshSession);
const loginUser = vi.mocked(api.loginUser);
const logoutUser = vi.mocked(api.logoutUser);

// Builds an unsigned JWT-shaped string whose payload carries the given expiry (seconds).
function tokenExpiringAt(expSeconds: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ exp: expSeconds })}.sig`;
}

const USER = { id: "u1", email: "a@b.test", fullName: "Demo Admin", tenantId: "t1", role: "admin" };

beforeEach(() => {
  vi.useFakeTimers();
  useAuthStore.setState({ accessToken: null, user: null, loading: false, restoring: true, error: null });
  refreshSession.mockReset();
  loginUser.mockReset();
  logoutUser.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  useAuthStore.getState().logout();
  vi.useRealTimers();
});

describe("token expiry helpers", () => {
  it("reads exp from a JWT payload", () => {
    expect(tokenExpiryMs(tokenExpiringAt(2_000_000_000))).toBe(2_000_000_000_000);
  });

  it("returns null for anything that is not a JWT", () => {
    expect(tokenExpiryMs("not-a-token")).toBeNull();
    expect(tokenExpiryMs("a.%%%.c")).toBeNull();
  });

  it("renews one minute before expiry, but never sooner than 5 seconds", () => {
    const now = 1_000_000;
    expect(msUntilRefresh(tokenExpiringAt((now + 15 * 60_000) / 1000), now)).toBe(14 * 60_000);
    expect(msUntilRefresh(tokenExpiringAt((now + 10_000) / 1000), now)).toBe(5_000);
  });

  it("caps the wait at the largest delay setTimeout supports", () => {
    expect(msUntilRefresh(tokenExpiringAt(4_000_000_000), 0)).toBe(2_147_483_647);
  });
});

describe("auth store", () => {
  it("shares one refresh request between overlapping restoreSession calls", async () => {
    refreshSession.mockResolvedValue({ accessToken: tokenExpiringAt(4_000_000_000), user: USER });
    await Promise.all([useAuthStore.getState().restoreSession(), useAuthStore.getState().restoreSession()]);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toEqual(USER);
  });

  it("renews the access token before it expires", async () => {
    const first = tokenExpiringAt(Math.floor(Date.now() / 1000) + 15 * 60);
    const second = tokenExpiringAt(Math.floor(Date.now() / 1000) + 30 * 60);
    loginUser.mockResolvedValue({ accessToken: first, user: USER });
    refreshSession.mockResolvedValue({ accessToken: second, user: USER });

    await useAuthStore.getState().login({ email: "a@b.test", password: "password-123", tenantSlug: "demo" });
    expect(useAuthStore.getState().accessToken).toBe(first);

    await vi.advanceTimersByTimeAsync(14 * 60_000 + 1_000);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe(second);
  });

  it("signs out with a message when a scheduled renewal fails", async () => {
    loginUser.mockResolvedValue({ accessToken: tokenExpiringAt(Math.floor(Date.now() / 1000) + 120), user: USER });
    refreshSession.mockRejectedValue(new Error("expired"));

    await useAuthStore.getState().login({ email: "a@b.test", password: "password-123", tenantSlug: "demo" });
    await vi.advanceTimersByTimeAsync(61_000);

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().error).toMatch(/session expired/i);
  });

  it("stays quietly signed out when there is no session to restore", async () => {
    refreshSession.mockRejectedValue(new Error("no cookie"));
    await useAuthStore.getState().restoreSession();
    expect(useAuthStore.getState()).toMatchObject({ user: null, restoring: false, error: null });
  });
});
