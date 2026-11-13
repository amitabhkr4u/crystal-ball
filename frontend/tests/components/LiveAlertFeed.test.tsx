import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { humanize, LiveAlertFeed } from "../../components/LiveAlertFeed";
import { useAuthStore } from "../../store/authStore";

const handlers = vi.hoisted(() => ({}) as Record<string, (payload?: unknown) => void>);
vi.mock("socket.io-client", () => ({
  io: () => ({
    on: (event: string, handler: (payload?: unknown) => void) => {
      handlers[event] = handler;
    },
    disconnect: vi.fn()
  })
}));

const alert = (over: Record<string, unknown> = {}) => ({
  alertId: "a-1",
  siteId: "site-demo",
  severity: "P0",
  urgency: "immediate",
  operatorSummary: "Smoke detected",
  fallback: false,
  processedAt: "2026-11-13T10:00:00.000Z",
  routing: { destination: "on_call", targetWindow: "immediate" },
  ...over
});

beforeEach(() => {
  for (const key of Object.keys(handlers)) delete handlers[key];
  useAuthStore.setState({
    accessToken: "tok",
    user: { id: "u1", email: "a@b.test", fullName: "Demo", tenantId: "t1", role: "operator" },
    restoring: false
  });
});

describe("humanize", () => {
  it("turns machine values into readable text", () => {
    expect(humanize("same_shift")).toBe("Same shift");
    expect(humanize(undefined)).toBe("");
  });
});

describe("LiveAlertFeed", () => {
  it("shows one card per alertId even when the same alert is delivered twice", () => {
    render(<LiveAlertFeed />);
    act(() => handlers["ai:classification:completed"]?.(alert()));
    act(() => handlers["ai:classification:completed"]?.(alert({ operatorSummary: "Updated summary" })));

    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Updated summary")).toBeInTheDocument();
  });

  it("offers Acknowledge to operators but hides the human override form", () => {
    render(<LiveAlertFeed />);
    act(() => handlers["ai:classification:completed"]?.(alert()));

    expect(screen.getByRole("button", { name: /acknowledge/i })).toBeInTheDocument();
    expect(screen.queryByText("Human override")).not.toBeInTheDocument();
  });

  it("shows an acknowledged state instead of the button once acknowledged", () => {
    render(<LiveAlertFeed />);
    act(() => handlers["ai:classification:completed"]?.(alert({ acknowledgement: { by: "u1", at: "x" } })));

    expect(screen.getByText(/acknowledged/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^acknowledge$/i })).not.toBeInTheDocument();
  });

  it("reports a reconnecting state when the socket cannot connect", () => {
    render(<LiveAlertFeed />);
    act(() => handlers["connect_error"]?.());
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
