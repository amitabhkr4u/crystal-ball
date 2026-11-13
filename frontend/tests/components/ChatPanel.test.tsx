import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../../components/ChatPanel";
import * as api from "../../lib/api";
import { useAssistantStore } from "../../store/assistantStore";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, streamAi: vi.fn(), fetchApprovals: vi.fn() };
});

const streamAi = vi.mocked(api.streamAi);
type Ev = api.StreamEvent;

const APPROVALS = [
  {
    id: "APR-001",
    title: "Site Patrol Onboarding & Checklists",
    type: "Folder" as const,
    submittedBy: "Sam HelpAdmin",
    status: "Pending Review" as const,
    statusDate: "Sep 18"
  },
  {
    id: "APR-003",
    title: "Safety Equipment & Sensor Specs",
    type: "PDF" as const,
    submittedBy: "Sam HelpAdmin",
    status: "Pending Review" as const,
    statusDate: "Sep 18"
  }
];

const meta = (data: Partial<Extract<Ev, { type: "meta" }>["data"]> = {}): Ev => ({
  type: "meta",
  data: { fallback: false, ...data }
});
const token = (text: string): Ev => ({ type: "token", text });
const done = (fallback = false): Ev => ({ type: "done", fallback });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// Builds a scripted stream where promises act as manual gates.
function script(items: Array<Ev | Promise<void> | Error>): AsyncGenerator<Ev> {
  return (async function* () {
    for (const item of items) {
      if (item instanceof Promise) await item;
      else if (item instanceof Error) throw item;
      else yield item;
    }
  })();
}

beforeEach(() => {
  useAssistantStore.setState(useAssistantStore.getInitialState(), true);
  useAssistantStore.setState({ approvals: APPROVALS, open: true });
  streamAi.mockReset();
});

describe("ChatPanel structure", () => {
  it("shows the header and the five action entry points", () => {
    render(<ChatPanel />);
    expect(screen.getByText("Approvals Assistant")).toBeInTheDocument();
    for (const name of [/Present me Summary/i, /Talk to me/i, /Help me/i, /Teach me/i, /Replay Greeting/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("collapses to a launcher on close and re-opens", async () => {
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /close assistant/i }));
    expect(screen.queryByText("Approvals Assistant")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /open approvals assistant/i }));
    expect(screen.getByText("Approvals Assistant")).toBeInTheDocument();
  });
});

describe("loading state", () => {
  it("shows a visible 'Thinking' status until the first event arrives", async () => {
    const gate = deferred();
    streamAi.mockImplementation(() => script([gate.promise, meta(), token("Hi"), done()]));
    const user = userEvent.setup();
    render(<ChatPanel />);

    await user.click(screen.getByRole("button", { name: /Present me Summary/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/thinking/i);

    gate.resolve();
    await screen.findByText("Hi");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("streaming state", () => {
  it("renders tokens as they arrive, with a live indicator until done", async () => {
    const gate = deferred();
    streamAi.mockImplementation(() => script([meta(), token("Start "), gate.promise, token("with the PDF."), done()]));
    const user = userEvent.setup();
    render(<ChatPanel />);

    await user.click(screen.getByRole("button", { name: /Present me Summary/i }));

    expect(await screen.findByText(/Start/)).toBeInTheDocument();
    expect(screen.getByTestId("streaming-indicator")).toBeInTheDocument();
    expect(screen.queryByText(/with the PDF/)).not.toBeInTheDocument();

    gate.resolve();
    expect(await screen.findByText("Start with the PDF.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("streaming-indicator")).not.toBeInTheDocument());
  });

  it("renders the validated triage as an ordered list with titles", async () => {
    streamAi.mockImplementation(() =>
      script([
        meta({
          triage: {
            headline: "Two waiting",
            items: [
              { id: "APR-003", priority: "high", reason: "Safety first." },
              { id: "APR-001", priority: "medium", reason: "Onboarding next." }
            ]
          }
        }),
        token("Two items."),
        done()
      ])
    );
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /Present me Summary/i }));

    const list = await screen.findByRole("list", { name: /recommended review order/i });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Safety Equipment & Sensor Specs");
    expect(items[1]).toHaveTextContent("Site Patrol Onboarding & Checklists");
  });
});

describe("error and fallback states", () => {
  it("shows an alert with Retry when the request fails, and recovers on retry", async () => {
    streamAi.mockImplementationOnce(() =>
      script([new api.ApiError("RATE_LIMITED", "Too many requests. Please wait a moment.")])
    );
    streamAi.mockImplementationOnce(() => script([meta(), token("Recovered."), done()]));
    const user = userEvent.setup();
    render(<ChatPanel />);

    await user.click(screen.getByRole("button", { name: /Present me Summary/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Please wait a moment.");

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Recovered.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(streamAi).toHaveBeenCalledTimes(2);
  });

  it("keeps the partial answer and shows an alert when the stream is cut mid-answer", async () => {
    streamAi.mockImplementation(() =>
      script([
        meta(),
        token("Partial answer"),
        { type: "error", code: "STREAM_INTERRUPTED", message: "The answer was interrupted. You can retry." }
      ])
    );
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /Present me Summary/i }));

    expect(await screen.findByText("Partial answer")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/interrupted/i);
    expect(screen.queryByTestId("streaming-indicator")).not.toBeInTheDocument();
  });

  it("treats a stream that ends without 'done' as an error instead of freezing", async () => {
    streamAi.mockImplementation(() => script([meta(), token("Half")]));
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /Present me Summary/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("tells the operator when a built-in (non-AI) answer is shown", async () => {
    streamAi.mockImplementation(() =>
      script([meta({ fallback: true, reason: "timeout" }), token("Built-in answer."), done(true)])
    );
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /Present me Summary/i }));

    expect(await screen.findByText("Built-in answer.")).toBeInTheDocument();
    expect(screen.getByTestId("fallback-notice")).toHaveTextContent(/unavailable/i);
  });
});

describe("conversation actions", () => {
  it("Talk to me: waits for the operator, then sends the history to /talk", async () => {
    streamAi.mockImplementation(() => script([meta(), token("Start with the PDF."), done()]));
    const user = userEvent.setup();
    render(<ChatPanel />);

    await user.click(screen.getByRole("button", { name: /Talk to me/i }));
    expect(streamAi).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: /ask about your queue/i }), "Which first?{enter}");

    expect(await screen.findByText("Start with the PDF.")).toBeInTheDocument();
    expect(screen.getByText("Which first?")).toBeInTheDocument();
    expect(streamAi).toHaveBeenCalledWith(
      "talk",
      expect.objectContaining({ messages: [{ role: "user", content: "Which first?" }] }),
      expect.objectContaining({ sessionId: expect.any(String) })
    );
  });

  it("Teach me: starts the lesson immediately and accepts a follow-up", async () => {
    streamAi.mockImplementation(() => script([meta(), token("1. Open the item."), done()]));
    const user = userEvent.setup();
    render(<ChatPanel />);

    await user.click(screen.getByRole("button", { name: /Teach me/i }));
    expect(await screen.findByText("1. Open the item.")).toBeInTheDocument();
    expect(streamAi).toHaveBeenCalledWith("teach", expect.objectContaining({ messages: [] }), expect.anything());

    await user.type(screen.getByRole("textbox", { name: /follow-up/i }), "What about videos?{enter}");
    await waitFor(() => expect(streamAi).toHaveBeenCalledTimes(2));
    const body = streamAi.mock.calls[1][1] as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  it("sends the chosen language with each request", async () => {
    streamAi.mockImplementation(() => script([meta(), token("Namaste."), done()]));
    const user = userEvent.setup();
    render(<ChatPanel />);

    await user.selectOptions(screen.getByRole("combobox", { name: /language/i }), "Hindi");
    await user.click(screen.getByRole("button", { name: /Replay Greeting/i }));

    await screen.findByText("Namaste.");
    expect(streamAi).toHaveBeenCalledWith("greeting", { language: "Hindi" }, expect.anything());
  });
});
