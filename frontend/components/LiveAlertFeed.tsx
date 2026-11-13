"use client";

import { useEffect, useState } from "react";
import { Activity, Check, Radio, Send } from "lucide-react";
import { io, type Socket } from "socket.io-client";
import { useAuthStore } from "../store/authStore";
import {
  acknowledgeAlert,
  classifyAlert,
  errorMessage,
  overrideAlert,
  type AlertClassification
} from "../lib/api";

interface LiveAlert extends AlertClassification {
  alertId: string;
  siteId: string;
  processedAt: string;
}

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";
const MAX_EVENTS = 8;
const MIN_REASON_LENGTH = 10;
const ACK_ROLES = ["admin", "operator", "safety_lead"];

// Turns machine values such as "same_shift" into "Same shift".
export function humanize(value: string | undefined): string {
  if (!value) return "";
  const text = value.replace(/_/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const SEVERITY_OPTIONS = [
  { value: "P0", label: "P0 · Immediate" },
  { value: "P1", label: "P1 · Same shift" },
  { value: "P2", label: "P2 · Morning triage" },
  { value: "P3", label: "P3 · Routine" }
];

interface OverrideControlsProps {
  alertId: string;
  onApply: (alertId: string, severity: string, reason: string) => Promise<boolean>;
}

// Shows the severity and reason form for a human override.
function OverrideControls({ alertId, onApply }: OverrideControlsProps) {
  const [severity, setSeverity] = useState("P1");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmedReason = reason.trim();

  // Sends the override and clears the reason when it works.
  async function apply() {
    setBusy(true);
    const saved = await onApply(alertId, severity, trimmedReason);
    setBusy(false);
    if (saved) setReason("");
  }

  return (
    <details className="override-details">
      <summary>Human override</summary>
      <div className="override-controls">
        <select
          aria-label={`Override severity for ${alertId}`}
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          {SEVERITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          aria-label={`Override reason for ${alertId}`}
          placeholder="Reason (at least 10 characters)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || trimmedReason.length < MIN_REASON_LENGTH}
          onClick={() => void apply()}
        >
          {busy ? "Saving…" : "Apply override"}
        </button>
      </div>
    </details>
  );
}

// Shows live AI alert classifications from Socket.IO.
export function LiveAlertFeed() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const [connected, setConnected] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  const [acking, setAcking] = useState<string | null>(null);
  const [events, setEvents] = useState<LiveAlert[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const canOverride = Boolean(accessToken) && (user?.role === "admin" || user?.role === "safety_lead");
  const canAcknowledge = Boolean(accessToken) && ACK_ROLES.includes(user?.role ?? "");

  useEffect(() => {
    if (!accessToken) {
      setConnected(false);
      setConnectFailed(false);
      return;
    }
    const socket: Socket = io(SOCKET_URL, { auth: { token: accessToken }, transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      setConnected(true);
      setConnectFailed(false);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => {
      setConnected(false);
      setConnectFailed(true);
    });
    // An alert can be delivered more than once (job retry, override, acknowledge); keep one card per alertId.
    socket.on("ai:classification:completed", (event: LiveAlert) =>
      setEvents((current) => [event, ...current.filter((e) => e.alertId !== event.alertId)].slice(0, MAX_EVENTS))
    );
    return () => {
      socket.disconnect();
      setConnected(false);
    };
  }, [accessToken]);

  // Saves a human override and updates the alert in the list.
  async function applyOverride(alertId: string, severity: string, reason: string): Promise<boolean> {
    if (!accessToken || reason.length < MIN_REASON_LENGTH) return false;
    setMessage("");
    try {
      const { classification } = await overrideAlert(accessToken, alertId, { severity, reason });
      setEvents((current) =>
        current.map((event) => (event.alertId === alertId ? { ...event, ...classification } : event))
      );
      setMessage(`Human override applied to ${alertId}; routing handoff queued.`);
      return true;
    } catch (error) {
      setMessage(errorMessage(error, "Could not apply override"));
      return false;
    }
  }

  // Records that the signed-in operator has seen the alert.
  async function acknowledge(alertId: string) {
    if (!accessToken) return;
    setAcking(alertId);
    setMessage("");
    try {
      const { classification } = await acknowledgeAlert(accessToken, alertId);
      setEvents((current) =>
        current.map((event) => (event.alertId === alertId ? { ...event, ...classification } : event))
      );
      setMessage(`Alert ${alertId} acknowledged.`);
    } catch (error) {
      setMessage(errorMessage(error, "Could not acknowledge alert"));
    } finally {
      setAcking(null);
    }
  }

  // Queues a demo P0 smoke alert for classification.
  async function simulateAlert() {
    if (!accessToken) return;
    setSending(true);
    setMessage("");
    try {
      const result = await classifyAlert(accessToken, {
        alertId: `demo-${crypto.randomUUID()}`,
        siteId: "site-demo",
        sensorId: "smoke-sensor-01",
        severity: "P0",
        occurredAt: new Date().toISOString(),
        payload: { smokeLevel: 0.98, source: "operator-demo" }
      });
      setMessage(`Alert queued: ${result.jobId}. Waiting for live classification…`);
    } catch (error) {
      setMessage(errorMessage(error, "Could not queue alert"));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="live-card">
      <div className="live-heading">
        <div>
          <span className="eyebrow">REAL-TIME OPERATIONS</span>
          <h2>IoT alert intelligence</h2>
          <p className="muted">Queue a sample P0 smoke alert and receive its asynchronous AI result over Socket.IO.</p>
        </div>
        <span className={`socket-state ${connected ? "is-connected" : ""}`}>
          <Radio size={14} />{" "}
          {connected
            ? "Live connected"
            : !accessToken
              ? "Sign in to connect"
              : connectFailed
                ? "Reconnecting…"
                : "Connecting…"}
        </span>
      </div>

      {accessToken && (
        <button type="button" className="simulate-button" onClick={simulateAlert} disabled={sending}>
          <Send size={15} /> {sending ? "Queuing alert…" : "Simulate P0 smoke alert"}
        </button>
      )}
      {message && (
        <p className="inline-status" role="status">
          {message}
        </p>
      )}

      <div className="event-list" aria-live="polite" aria-label="Live alert classifications">
        {events.length === 0 ? (
          <div className="empty-events">
            <Activity size={20} />
            <span>No live classifications received yet.</span>
          </div>
        ) : (
          events.map((event) => (
            <article className="event-item" key={event.alertId}>
              <div className="event-top">
                <span>
                  <span className={`sev sev-${event.severity}`}>{event.severity}</span>{" "}
                  <strong>{event.siteId}</strong>
                </span>
                <span>{humanize(event.urgency)}</span>
              </div>
              <p>{event.operatorSummary}</p>
              <small>
                Routed to {humanize(event.routing?.destination) || "operator review"} ·{" "}
                {humanize(event.routing?.targetWindow || event.urgency)} ·{" "}
                {event.fallback ? "Deterministic fallback" : "LLM classification"} · human review required ·{" "}
                {new Date(event.processedAt).toLocaleTimeString()}
              </small>
              {event.acknowledgement ? (
                <p className="ack-state">
                  <Check size={14} aria-hidden="true" /> Acknowledged
                </p>
              ) : (
                canAcknowledge && (
                  <button
                    type="button"
                    className="secondary-button ack-button"
                    disabled={acking === event.alertId}
                    onClick={() => void acknowledge(event.alertId)}
                  >
                    <Check size={14} aria-hidden="true" /> {acking === event.alertId ? "Saving…" : "Acknowledge"}
                  </button>
                )
              )}
              {canOverride && <OverrideControls alertId={event.alertId} onApply={applyOverride} />}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
