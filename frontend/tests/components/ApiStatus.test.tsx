import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_MAP, ApiStatus } from "../../components/ApiStatus";
import { ChatPanel } from "../../components/ChatPanel";
import * as api from "../../lib/api";
import { useAssistantStore } from "../../store/assistantStore";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, streamAi: vi.fn(), fetchApprovals: vi.fn(), fetchHealth: vi.fn() };
});

const fetchHealth = vi.mocked(api.fetchHealth);
const streamAi = vi.mocked(api.streamAi);
type Ev = api.StreamEvent;

async function* script(events: Ev[]): AsyncGenerator<Ev> {
  for (const e of events) yield e;
}

beforeEach(() => {
  useAssistantStore.setState(useAssistantStore.getInitialState(), true);
  fetchHealth.mockReset();
  streamAi.mockReset();
});

describe("ApiStatus bar", () => {
  it("shows API online when /api/health answers, and links to Swagger", async () => {
    fetchHealth.mockResolvedValue(true);
    render(<ApiStatus />);

    expect(await screen.findByText("API online")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /API docs \(Swagger\)/i });
    expect(link).toHaveAttribute("href", "http://localhost:4000/api/docs/");
  });

  it("shows API offline instead of breaking when the health check fails", async () => {
    fetchHealth.mockResolvedValue(false);
    render(<ApiStatus />);
    expect(await screen.findByText("API offline")).toBeInTheDocument();
  });

  it("lists every endpoint in the API map", async () => {
    fetchHealth.mockResolvedValue(true);
    render(<ApiStatus />);
    expect(API_MAP).toHaveLength(11);
    for (const e of API_MAP) expect(screen.getByText(`${e.method} ${e.path}`)).toBeInTheDocument();
    await screen.findByText("API online");
  });
});

describe("Dev inspector", () => {
  it("is off by default and the toggle turns it on", async () => {
    fetchHealth.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<ApiStatus />);
    await screen.findByText("API online");

    expect(useAssistantStore.getState().devMode).toBe(false);
    await user.click(screen.getByRole("checkbox", { name: /Dev inspector/i }));
    expect(useAssistantStore.getState().devMode).toBe(true);
  });

  it("tags each action card with its endpoint when on", () => {
    useAssistantStore.setState({ devMode: true });
    render(<ChatPanel />);
    for (const mode of ["summary", "talk", "help", "teach", "greeting"]) {
      expect(screen.getByText(`POST /api/ai/${mode}`)).toBeInTheDocument();
    }
  });

  it("shows endpoint, prompt version, fallback reason and latency under an answer", async () => {
    useAssistantStore.setState({ devMode: true });
    streamAi.mockImplementation(() =>
      script([
        { type: "meta", data: { fallback: true, reason: "timeout", promptVersion: "summary.triage.v1" } },
        { type: "token", text: "Built-in answer." },
        { type: "done", fallback: true }
      ])
    );
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /Present me Summary/i }));

    const line = await screen.findByTestId("dev-line");
    expect(line).toHaveTextContent("POST /api/ai/summary");
    expect(line).toHaveTextContent("summary.triage.v1");
    expect(line).toHaveTextContent("fallback (timeout)");
    expect(line).toHaveTextContent(/\d+ ms/);
  });

  it("shows nothing extra to a normal user", async () => {
    streamAi.mockImplementation(() =>
      script([
        { type: "meta", data: { fallback: false } },
        { type: "token", text: "Hello." },
        { type: "done", fallback: false }
      ])
    );
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /Replay Greeting/i }));

    expect(await screen.findByText("Hello.")).toBeInTheDocument();
    expect(screen.queryByTestId("dev-line")).not.toBeInTheDocument();
  });
});
