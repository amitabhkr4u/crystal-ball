import type { Approval } from "../lib/schemas";
import { useAssistantStore, type MessageDebug, type UiMessage } from "../store/assistantStore";
import { TriageList } from "./TriageList";

// Builds the dev inspector line for an answer.
function describeDebug(d: MessageDebug, fallback: boolean | undefined): string {
  const source =
    d.reason === "no_policy_match"
      ? "retrieval only, no LLM call"
      : fallback
        ? `fallback (${d.reason ?? "unknown"})`
        : "live LLM";
  return [`POST /api/ai/${d.path}`, d.promptVersion, source, d.ms !== undefined ? `${d.ms} ms` : null]
    .filter(Boolean)
    .join(" · ");
}

// Shows one chat message with its extras.
export function MessageBubble({ message, approvals }: { message: UiMessage; approvals: Approval[] }) {
  const devMode = useAssistantStore((s) => s.devMode);
  const isUser = message.role === "user";
  const hasText = message.content.length > 0;
  if (!isUser && !hasText && !message.triage) return null;

  return (
    <div className={`msg ${isUser ? "msg-user" : "msg-assistant"}`}>
      {message.triage && <TriageList triage={message.triage} approvals={approvals} />}
      {hasText && (
        <div className="bubble" aria-busy={message.streaming ? "true" : undefined}>
          {message.content}
          {message.streaming && <span className="caret" data-testid="streaming-indicator" aria-hidden="true" />}
        </div>
      )}
      {message.sources && message.sources.length > 0 && (
        <p className="sources">Sources: {message.sources.map((s) => `${s.id} ${s.title}`).join(" · ")}</p>
      )}
      {devMode && !isUser && message.debug && !message.streaming && (
        <p className="dev-line" data-testid="dev-line">
          {describeDebug(message.debug, message.fallback)}
        </p>
      )}
      {message.fallback && (
        <p className="notice" data-testid="fallback-notice">
          AI is unavailable right now - showing a built-in answer.
        </p>
      )}
    </div>
  );
}
