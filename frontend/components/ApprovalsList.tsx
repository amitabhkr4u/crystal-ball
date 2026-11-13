"use client";

import { FileImage, FileText, Folder, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { useAssistantStore } from "../store/assistantStore";
import { ApiStatus } from "./ApiStatus";
import type { Approval } from "../lib/schemas";

const ICONS: Record<Approval["type"], typeof Folder> = { Folder, Video, PDF: FileText, Image: FileImage };

// Lists the pending approvals.
export function ApprovalsList() {
  const { approvals, approvalsError, loadApprovals } = useAssistantStore();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadApprovals().finally(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [loadApprovals]);

  return (
    <section className="approvals" aria-labelledby="approvals-heading">
      <h2 id="approvals-heading">Approvals</h2>
      <p className="muted">Items waiting for your review.</p>
      <ApiStatus />
      {approvalsError && (
        <p className="error" role="alert">
          {approvalsError}
        </p>
      )}
      {!loaded && (
        <p className="muted" role="status">
          Loading approvals…
        </p>
      )}
      {loaded && !approvalsError && approvals.length === 0 && (
        <p className="empty-events" role="status">
          No approvals are waiting for review.
        </p>
      )}
      <ul className="approval-list">
        {approvals.map((a) => {
          const Icon = ICONS[a.type];
          return (
            <li key={a.id}>
              <span className="type-icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="approval-main">
                <strong>{a.title}</strong>
                <small>
                  {a.type} · Submitted by {a.submittedBy}
                </small>
              </span>
              <span className="status">
                {a.status} - {a.statusDate}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
