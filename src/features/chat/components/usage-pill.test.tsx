// @vitest-environment happy-dom
//
// The pill's label and which popup sections exist are the contract: every
// agent reports something different, and a section for data that was never
// reported is exactly the "0 tokens · $0.0000" the old widget was.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => null as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "../stores/chat-store";
import { useModelPricingStore } from "@/features/settings/stores/model-pricing-store";
import { UsagePill } from "./usage-pill";

const TAB = "tab-1";

function patch(over: Record<string, unknown>) {
  useChatStore.setState((s) => ({
    sessions: { ...s.sessions, [TAB]: { ...s.sessions[TAB], ...over } },
  }));
}

const sections = () =>
  Array.from(document.querySelectorAll("[data-section]")).map((el) =>
    el.getAttribute("data-section"),
  );

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useModelPricingStore.setState({ prices: {}, loaded: true, loading: false });
});

describe("UsagePill", () => {
  it("reads 'Usage' with nothing reported, and opens to an honest empty state", () => {
    render(<UsagePill tabId={TAB} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("Usage");
    expect(button.dataset.usageState).toBe("idle");
    // Always a ring, never the old speedometer: unknown window → dashed track.
    expect(button.querySelector("[data-usage-ring='unknown']")).toBeTruthy();
    fireEvent.click(button);
    expect(sections()).toEqual(["empty"]);
  });

  it("shows the context percentage once a gauge arrives, and only a context card", () => {
    render(<UsagePill tabId={TAB} />);
    act(() => patch({ contextUsage: { used: 84_200, size: 200_000, cost: 0 } }));
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("42%");
    expect(button.dataset.usageState).toBe("context");
    expect(button.querySelector("[data-usage-ring='known']")).toBeTruthy();
    expect(button.getAttribute("title")).toContain("tokens used (42%)");
    expect(button.getAttribute("aria-label")).toContain((84_200).toLocaleString());
    expect(button.getAttribute("aria-label")).toContain((200_000).toLocaleString());
    fireEvent.click(button);
    // Codex over ACP: a gauge and nothing else — no Tokens, no Cost.
    expect(sections()).toEqual(["context"]);
  });

  it("updates the ring fill mid-run without swapping the glyph", () => {
    render(<UsagePill tabId={TAB} />);
    act(() => patch({ contextUsage: { used: 20_000, size: 200_000, cost: 0 } }));
    const button = screen.getByRole("button");
    const ring = button.querySelector("[data-usage-ring='known']");
    expect(button.textContent).toContain("10%");
    act(() => patch({ contextUsage: { used: 84_200, size: 200_000, cost: 0 } }));
    expect(button.textContent).toContain("42%");
    expect(button.querySelector("[data-usage-ring='known']")).toBe(ring);
    expect(button.getAttribute("title")).toContain("tokens used (42%)");
  });

  it("adds token rows and an estimated cost when a split and a price exist", () => {
    useModelPricingStore.setState({
      prices: { "claude-opus-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
      loaded: true,
      loading: false,
    });
    render(<UsagePill tabId={TAB} />);
    act(() =>
      patch({
        model: "claude-opus-5",
        contextUsage: { used: 10_000, size: 200_000, cost: 0 },
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 500,
          cost: 0,
        },
      }),
    );
    fireEvent.click(screen.getByRole("button"));
    expect(sections()).toEqual(["context", "tokens", "cost"]);
    // The total and the Input row both read $15.00 — output is zero here.
    expect(screen.getAllByText("$15.00").length).toBeGreaterThan(0);
    expect(screen.getByText("est.")).toBeTruthy();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("asks capture for the record only while open, and shows what it knows", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "capture_session_summary"
        ? {
            id: "row",
            title: null,
            agent: "claude-code",
            model: null,
            source: "acp",
            startedAt: "2026-09-16T00:00:00Z",
            updatedAt: "2026-09-16T00:00:00Z",
            lastActivityAt: "2026-09-16T00:00:00Z",
            activeSeconds: 125,
            wallSeconds: 300,
            messageCount: 6,
            toolCallCount: 9,
            checkpointCount: 0,
            branches: [],
            insertions: 12,
            deletions: 3,
            filesTouched: 2,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            contextUsed: null,
            contextSize: null,
            needsAttention: false,
            attentionReason: null,
          }
        : null,
    );
    render(<UsagePill tabId={TAB} />);
    act(() => patch({ acpSessionId: "acp-1", workingDirectory: "/proj" }));
    expect(invoke).not.toHaveBeenCalledWith("capture_session_summary", expect.anything());

    fireEvent.click(screen.getByRole("button"));
    await screen.findByText("Tool calls");
    expect(invoke).toHaveBeenCalledWith("capture_session_summary", {
      projectPath: "/proj",
      sessionId: "acp-1",
    });
    expect(sections()).toEqual(["session"]);
    expect(screen.getByText("2m")).toBeTruthy();
    expect(screen.getByText("+12")).toBeTruthy();
  });

  it("says it is compacting while the agent compacts", () => {
    render(<UsagePill tabId={TAB} />);
    act(() => patch({ compacting: true }));
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("Compacting…");
    expect(button.dataset.usageState).toBe("compacting");
    // Same 12 px ring as every other state — a pulse-dot swap was a layout hitch.
    expect(button.querySelector("svg[data-usage-ring]")).toBeTruthy();
  });

  it("keeps token counts when the agent reports a split but no window", () => {
    render(<UsagePill tabId={TAB} />);
    act(() =>
      patch({
        usage: {
          input_tokens: 1_000,
          output_tokens: 250,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          cost: 0,
        },
      }),
    );
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("1.3K");
    expect(button.dataset.usageState).toBe("tokens");
    expect(button.querySelector("[data-usage-ring='unknown']")).toBeTruthy();
    expect(button.getAttribute("title")).toContain("1.3K tokens");
  });
});
