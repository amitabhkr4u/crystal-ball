"use client";

import { ArrowLeft, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAssistantStore, type Mode } from "../store/assistantStore";
import { ActionCards } from "./ActionCards";
import { MessageBubble } from "./MessageBubble";

const LANGUAGES = ["English", "Hindi", "Spanish", "French"];

const COMPOSER: Partial<Record<Mode, { label: string; hint: string }>> = {
  talk: {
    label: "Ask about your queue…",
    hint: "Ask me anything about the pending approvals - for example, which one needs attention first and why."
  },
  help: {
    label: "Ask a policy question…",
    hint: "Ask an operational question. I answer only from the approvals policy note."
  },
  teach: { label: "Ask a follow-up…", hint: "" }
};

const RERUN: Partial<Record<Mode, string>> = { summary: "Refresh summary", greeting: "Replay Greeting" };

// Shows the assistant chat panel and its composer.
export function ChatPanel() {
  const { open, mode, status, error, messages, approvals, language } = useAssistantStore();
  const { openPanel, closePanel, backToMenu, setLanguage, startMode, sendMessage, retry } =
    useAssistantStore.getState();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  if (!open) {
    return (
      <button
        type="button"
        className="launcher"
        aria-label="Open Approvals Assistant"
        title="Approvals Assistant"
        onClick={openPanel}
      >
        <Sparkles size={22} />
      </button>
    );
  }

  const busy = status === "loading" || status === "streaming";
  const composer = mode ? COMPOSER[mode] : undefined;

  // Sends the typed message and clears the box.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    sendMessage(draft);
    setDraft("");
  };

  return (
    <section
      className="panel"
      aria-label="Approvals Assistant panel"
      onKeyDown={(e) => {
        if (e.key === "Escape") closePanel();
      }}
    >
      <header className="panel-header">
        {mode && (
          <button type="button" className="icon-btn" aria-label="Back to actions" onClick={backToMenu}>
            <ArrowLeft size={18} />
          </button>
        )}
        <span className="avatar" aria-hidden="true">
          <Sparkles size={18} />
        </span>
        <div className="panel-title">
          <strong>Approvals Assistant</strong>
          <small>{approvals.length} pending review</small>
        </div>
        <button type="button" className="icon-btn" aria-label="Close assistant" onClick={closePanel}>
          <X size={18} />
        </button>
      </header>

      <div className="toolbar">
        <label className="lang">
          <span>Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="panel-body">
        {mode === null ? (
          <>
            <p className="greeting-line">Hi! What would you like help with?</p>
            <ActionCards onSelect={startMode} />
          </>
        ) : (
          <div className="conversation" role="log" aria-live="polite">
            {composer?.hint && messages.length === 0 && <p className="hint">{composer.hint}</p>}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} approvals={approvals} />
            ))}
            {status === "loading" && (
              <div className="thinking" role="status">
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                Thinking…
              </div>
            )}
            {status === "error" && (
              <div className="error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={retry}>
                  <RotateCcw size={14} /> Retry
                </button>
              </div>
            )}
            {status === "idle" && mode && RERUN[mode] && messages.length > 0 && (
              <button type="button" className="rerun" onClick={() => startMode(mode)}>
                <RotateCcw size={14} /> {RERUN[mode]}
              </button>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {composer && (
        <form className="composer" onSubmit={submit}>
          <input
            aria-label={composer.label}
            placeholder={composer.label}
            value={draft}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" aria-label="Send" disabled={busy || !draft.trim()}>
            <Send size={16} />
          </button>
        </form>
      )}
    </section>
  );
}
