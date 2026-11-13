import { create } from "zustand";
import { errorMessage, loginUser, logoutUser, refreshSession, type AuthPayload, type AuthUser } from "../lib/api";

interface LoginInput {
  email: string;
  password: string;
  tenantSlug: string;
}

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  loading: boolean;
  restoring: boolean;
  error: string | null;
  // Restores the login from the refresh cookie (also used to renew an expiring access token).
  restoreSession: () => Promise<void>;
  // Signs in and saves the token and user.
  login: (input: LoginInput) => Promise<void>;
  // Signs out and clears the saved login.
  logout: () => void;
}

// Renew this long before the access token expires, and never poll faster than every 5 seconds.
const REFRESH_MARGIN_MS = 60_000;
const MIN_DELAY_MS = 5_000;
// setTimeout stores its delay in 32 bits; a longer delay fires immediately instead of waiting.
const MAX_TIMER_MS = 2_147_483_647;

// Reads the expiry (ms since epoch) from a JWT payload. The browser never trusts it for security;
// the API verifies the signature on every request. It is only used to decide when to renew.
export function tokenExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// Milliseconds to wait before renewing this token, or null when its expiry cannot be read.
export function msUntilRefresh(token: string, now: number = Date.now()): number | null {
  const expiry = tokenExpiryMs(token);
  return expiry === null ? null : Math.min(Math.max(expiry - now - REFRESH_MARGIN_MS, MIN_DELAY_MS), MAX_TIMER_MS);
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
// The refresh token is single-use, so two overlapping refreshes (React StrictMode runs effects
// twice in development) would make the second one fail and sign the user out. Share one request.
let inflight: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => {
  // Stores a new session and schedules its renewal.
  function applySession(data: AuthPayload): void {
    set({ accessToken: data.accessToken, user: data.user, loading: false, restoring: false, error: null });
    clearTimeout(refreshTimer);
    const delay = msUntilRefresh(data.accessToken);
    if (delay !== null) refreshTimer = setTimeout(() => void get().restoreSession(), delay);
  }

  return {
    accessToken: null,
    user: null,
    loading: false,
    restoring: true,
    error: null,

    // Restores the login from the refresh cookie.
    restoreSession: () => {
      inflight ??= (async () => {
        try {
          applySession(await refreshSession());
        } catch {
          clearTimeout(refreshTimer);
          set((state) => ({
            accessToken: null,
            user: null,
            restoring: false,
            error: state.user ? "Your session expired. Please sign in again." : null
          }));
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    // Signs in and saves the token and user.
    login: async (input) => {
      set({ loading: true, error: null });
      try {
        applySession(await loginUser(input));
      } catch (error) {
        set({ loading: false, error: errorMessage(error, "Sign in failed") });
        throw error;
      }
    },

    // Signs out and clears the saved login.
    logout: () => {
      clearTimeout(refreshTimer);
      void logoutUser().catch(() => undefined);
      set({ accessToken: null, user: null, error: null, restoring: false });
    }
  };
});
