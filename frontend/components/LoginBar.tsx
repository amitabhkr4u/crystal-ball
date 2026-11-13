"use client";

import { FormEvent, useEffect, useState } from "react";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { useAuthStore } from "../store/authStore";

// Shows the sign-in form or the signed-in user.
export function LoginBar() {
  const { user, loading, restoring, error, login, logout, restoreSession } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  // Signs in and clears the password field on success.
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await login({ email, password, tenantSlug });
      setPassword("");
    } catch {
      return;
    }
  }

  if (restoring) return <section className="auth-bar">Restoring secure session…</section>;

  if (user) {
    return (
      <section className="auth-bar">
        <span>
          <ShieldCheck size={16} /> Signed in as <strong>{user.fullName}</strong> · {user.role}
        </span>
        <button type="button" onClick={logout} className="secondary-button">
          <LogOut size={15} /> Sign out
        </button>
      </section>
    );
  }

  return (
    <section className="auth-card">
      <div>
        <strong>Tenant sign in</strong>
        <p className="muted">Use a seeded tenant account to enable authenticated live alerts.</p>
      </div>
      <form onSubmit={submit} className="auth-form">
        <input
          aria-label="Tenant slug"
          placeholder="Tenant slug"
          autoComplete="organization"
          value={tenantSlug}
          onChange={(e) => setTenantSlug(e.target.value)}
          required
          minLength={2}
        />
        <input
          aria-label="Email"
          type="email"
          autoComplete="username"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          aria-label="Password"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <button disabled={loading} type="submit">
          <LogIn size={15} /> {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
