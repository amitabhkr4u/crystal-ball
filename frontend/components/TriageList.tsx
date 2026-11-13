import type { Approval, Triage } from "../lib/schemas";

// Shows approvals in the recommended review order.
export function TriageList({ triage, approvals }: { triage: Triage; approvals: Approval[] }) {
  const title = (id: string) => approvals.find((a) => a.id === id)?.title ?? id;
  return (
    <ol className="triage" aria-label="Recommended review order">
      {triage.items.map((item) => (
        <li key={item.id}>
          <span className={`badge badge-${item.priority}`}>{item.priority}</span>
          <span className="triage-copy">
            <strong>{title(item.id)}</strong>
            <small>{item.reason}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}
