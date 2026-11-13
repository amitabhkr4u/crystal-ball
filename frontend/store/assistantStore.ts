import { create } from "zustand";
import { ApiError, fetchApprovals, streamAi, type AiPath } from "../lib/api";
import type { Approval, FallbackReason, Triage } from "../lib/schemas";

export type Mode = "summary" | "talk" | "help" | "teach" | "greeting";
export type Status = "idle" | "loading" | "streaming" | "error";

export interface MessageDebug {
  path: AiPath;
  promptVersion?: string;
  reason?: FallbackReason;
  ms?: number;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  fallback?: boolean;
  triage?: Triage;
  sources?: Array<{ id: string; title: string }>;
  debug?: MessageDebug;
}

interface LastRun {
  path: AiPath;
  body: Record<string, unknown>;
}

interface AssistantState {
  open: boolean;
  mode: Mode | null;
  status: Status;
  error: string | null;
  messages: UiMessage[];
  approvals: Approval[];
  approvalsError: string | null;
  language: string;
  sessionId: string;
  lastRun: LastRun | null;
  devMode: boolean;
  toggleDevMode: () => void;
  openPanel: () => void;
  closePanel: () => void;
  backToMenu: () => void;
  setLanguage: (language: string) => void;
  loadApprovals: () => Promise<void>;
  startMode: (mode: Mode) => void;
  sendMessage: (text: string) => void;
  retry: () => void;
}

// Creates a random id for this chat session.
const newSessionId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Math.random().toString(36).slice(2)}`;

let activeController: AbortController | null = null;
let counter = 0;
// Creates the next message id.
const nextId = (): string => `m${++counter}`;

export const useAssistantStore = create<AssistantState>()((set, get) => {
  // Streams one assistant answer into the store.
  async function run(path: AiPath, body: Record<string, unknown>, userText?: string): Promise<void> {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const assistantId = nextId();
    const startedAt = Date.now();

    set((s) => ({
      status: "loading",
      error: null,
      lastRun: { path, body },
      messages: [
        ...s.messages,
        ...(userText ? [{ id: nextId(), role: "user" as const, content: userText }] : []),
        { id: assistantId, role: "assistant" as const, content: "", streaming: true }
      ]
    }));

    // Updates fields of the current assistant message.
    const patch = (p: Partial<UiMessage>) =>
      set((s) => ({ messages: s.messages.map((m) => (m.id === assistantId ? { ...m, ...p } : m)) }));

    try {
      let finished = false;
      for await (const event of streamAi(path, body, { sessionId: get().sessionId, signal: controller.signal })) {
        if (controller.signal.aborted) return;
        switch (event.type) {
          case "meta":
            patch({
              fallback: event.data.fallback,
              triage: event.data.triage,
              sources: event.data.sources,
              debug: { path, promptVersion: event.data.promptVersion, reason: event.data.reason }
            });
            break;
          case "token":
            set((s) => ({
              status: "streaming",
              messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: m.content + event.text } : m))
            }));
            break;
          case "done":
            finished = true;
            set((s) => ({
              status: "idle",
              messages: s.messages.map((m) =>
                m.id === assistantId
                  ? { ...m, streaming: false, debug: { ...m.debug, path, ms: Date.now() - startedAt } }
                  : m
              )
            }));
            break;
          case "error":
            throw new ApiError(event.code, event.message);
        }
      }
      if (!finished)
        throw new ApiError("STREAM_ENDED", "The connection closed before the answer finished. Please retry.");
    } catch (err) {
      if (controller.signal.aborted) return;
      patch({ streaming: false });
      set({
        status: "error",
        error: err instanceof ApiError ? err.message : "Something went wrong. Please try again."
      });
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  // Clears the conversation and sets the mode.
  const reset = (mode: Mode | null) => {
    activeController?.abort();
    activeController = null;
    set({ mode, messages: [], status: "idle", error: null, lastRun: null });
  };

  return {
    open: false,
    mode: null,
    status: "idle",
    error: null,
    messages: [],
    approvals: [],
    approvalsError: null,
    language: "English",
    sessionId: newSessionId(),
    lastRun: null,
    devMode: false,

    // Turns the dev inspector on or off.
    toggleDevMode: () => set((s) => ({ devMode: !s.devMode })),
    // Opens the assistant panel.
    openPanel: () => set({ open: true }),
    // Resets the chat and closes the panel.
    closePanel: () => {
      reset(null);
      set({ open: false });
    },
    // Returns to the action menu.
    backToMenu: () => reset(null),
    // Saves the chosen answer language.
    setLanguage: (language) => set({ language }),

    // Loads approvals into the store.
    loadApprovals: async () => {
      try {
        set({ approvals: await fetchApprovals(), approvalsError: null });
      } catch (err) {
        set({ approvalsError: err instanceof ApiError ? err.message : "Could not load approvals." });
      }
    },

    // Starts a chat mode and runs its first request.
    startMode: (mode) => {
      reset(mode);
      const { language } = get();
      if (mode === "summary") void run("summary", { language });
      else if (mode === "greeting") void run("greeting", { language });
      else if (mode === "teach") void run("teach", { language, messages: [] });
    },

    // Sends the user message in the current mode.
    sendMessage: (text) => {
      const clean = text.trim();
      const { mode, status, messages, language } = get();
      if (!clean || status === "loading" || status === "streaming") return;
      const history = messages.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }));
      if (mode === "talk")
        void run("talk", { language, messages: [...history, { role: "user", content: clean }] }, clean);
      else if (mode === "teach")
        void run("teach", { language, messages: [...history, { role: "user", content: clean }] }, clean);
      else if (mode === "help") void run("help", { language, question: clean }, clean);
    },

    // Runs the last request again.
    retry: () => {
      const { lastRun, messages } = get();
      if (!lastRun) return;
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") set({ messages: messages.slice(0, -1) });
      void run(lastRun.path, lastRun.body);
    }
  };
});
