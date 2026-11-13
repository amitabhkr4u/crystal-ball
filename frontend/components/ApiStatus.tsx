"use client";

import { Activity, ExternalLink, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchHealth } from "../lib/api";
import { useAssistantStore } from "../store/assistantStore";

const DOCS_URL = process.env.NEXT_PUBLIC_API_DOCS_URL ?? "http://localhost:4000/api/docs/";

type Health = "checking" | "online" | "offline";

export const API_MAP = [
  { method: "GET", path: "/api/health", usedBy: "Status chip (this bar)" },
  { method: "GET", path: "/api/approvals", usedBy: "Approvals list" },
  { method: "POST", path: "/api/v1/auth/login", usedBy: "Tenant sign in" },
  { method: "POST", path: "/api/v1/alerts/classify", usedBy: "Asynchronous IoT alert classification" },
  { method: "POST", path: "/api/v1/alerts/{alertId}/override", usedBy: "Audited human override and rerouting" },
  { method: "Socket.IO", path: "ai:classification:completed", usedBy: "Live alert intelligence feed" },
  { method: "POST", path: "/api/ai/summary", usedBy: "Present me Summary" },
  { method: "POST", path: "/api/ai/talk", usedBy: "Talk to me" },
  { method: "POST", path: "/api/ai/help", usedBy: "Help me" },
  { method: "POST", path: "/api/ai/teach", usedBy: "Teach me" },
  { method: "POST", path: "/api/ai/greeting", usedBy: "Replay Greeting" }
] as const;

const LABEL: Record<Health, string> = { checking: "Checking API…", online: "API online", offline: "API offline" };

// Shows API health, docs link and the dev inspector toggle.
export function ApiStatus() {
  const devMode = useAssistantStore((s) => s.devMode);
  const toggleDevMode = useAssistantStore((s) => s.toggleDevMode);
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    let alive = true;
    void fetchHealth().then((ok) => {
      if (alive) setHealth(ok ? "online" : "offline");
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="api-bar" aria-label="API status">
      <div className="api-bar-row">
        <span className={`health health-${health}`} role="status">
          <Activity size={14} aria-hidden="true" /> {LABEL[health]}
        </span>
        <a className="api-link" href={DOCS_URL} target="_blank" rel="noreferrer">
          <ExternalLink size={14} aria-hidden="true" /> API docs (Swagger)
        </a>
        <label className="dev-toggle">
          <input type="checkbox" checked={devMode} onChange={toggleDevMode} />
          <Terminal size={14} aria-hidden="true" /> Dev inspector
        </label>
      </div>
      <details className="api-map">
        <summary>API map: which UI part calls which endpoint</summary>
        <ul>
          {API_MAP.map((e) => (
            <li key={e.path}>
              <code>
                {e.method} {e.path}
              </code>
              <span>{e.usedBy}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
