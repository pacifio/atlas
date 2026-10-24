// @vitest-environment happy-dom
//
// The session Details card is a toggle and nothing else: opening or closing
// it must not change the transcript's or the composer's width or position,
// and must not re-render the transcript. It descends from a rail that took
// its width out of the row (and a matching `marginRight` on the composer), so
// the transcript narrowed and slid left every time it opened. Now the docked
// card is drawn into room the panel keeps whether or not it shows, and the
// popover form floats over the transcript.
//
// This renders the real panel and compares every box the column is laid out
// from (the row it is centred in, the column, the composer stack) with the
// card closed, open and closed again, docked and not. The panel's children
// are stubbed: what is under test is the frame, and how often the transcript
// renders.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("../lib/agents-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/agents-api")>();
  const agents = new Proxy({}, { get: () => vi.fn(async () => ({})) });
  return { ...real, agents, ensureAgent: vi.fn(async () => ({})), resetAgent: vi.fn() };
});
const Null = vi.hoisted(() => () => null);
vi.mock("./message-input", () => ({ MessageInput: Null }));
vi.mock("./session-header", () => ({ SessionHeaderControls: Null }));
vi.mock("./agent-update-bar", () => ({ AgentUpdateBar: Null }));
vi.mock("./permission-modal", () => ({ PermissionModal: Null }));
vi.mock("./chat-comments-controller", () => ({ ChatCommentsController: Null }));
vi.mock("./session-elicitation", () => ({ SessionElicitation: Null }));
const transcriptRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./transcript", () => ({
  Transcript: () => {
    transcriptRenders.count += 1;
    return null;
  },
}));
vi.mock("@/features/session-context/components/session-details-card", () => ({
  SessionDetailsCard: () => <div data-testid="details-card" />,
}));

import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSessionDetailsStore } from "@/features/session-context/stores/session-details-store";
import { sessionScope } from "../lib/session-scope";
import { useChatStore } from "../stores/chat-store";
import { ChatPanel } from "./chat-panel";

const TAB = "tab-1";
let WIDTH = 1200;

beforeEach(() => {
  localStorage.clear();
  WIDTH = 1200;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // happy-dom lays nothing out: give the conversation column a width.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-chat-drop-zone") ? WIDTH : 0;
    },
  );
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    drafts: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useSessionDetailsStore.setState({ open: {}, popoverFor: null, instant: false, dockable: {} });
  transcriptRenders.count = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function withMessages(acpSessionId?: string) {
  useChatStore.setState((s) => {
    if (acpSessionId) s.sessions[TAB].acpSessionId = acpSessionId;
    s.sessions[TAB].messages = [
      { id: "m1", role: "user", content: "hi", timestamp: 0 },
    ] as unknown as (typeof s.sessions)[typeof TAB]["messages"];
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatPanel tabId={TAB} />
    </QueryClientProvider>,
  );
}

/** Every box the transcript column's position and width come from, as
 *  React asked for it. */
function frame(root: HTMLElement) {
  const box = (sel: string) => {
    const el = root.querySelector<HTMLElement>(sel);
    expect(el, sel).not.toBeNull();
    return { style: el!.getAttribute("style"), className: el!.className };
  };
  return {
    row: box("[data-chat-row]"),
    column: box("[data-chat-column]"),
    composer: box("[data-chat-composer-stack]"),
  };
}

/** Any `marginRight` React was asked to render that is not the dock's px
 *  reservation: the old rail's `min(300px, 50%)`. */
const railMargin = (root: HTMLElement): string | undefined => {
  for (const el of root.querySelectorAll("*")) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
    const style = key
      ? (el as unknown as Record<string, { style?: { marginRight?: unknown } }>)[key]?.style
      : undefined;
    if (typeof style?.marginRight === "string") return style.marginRight;
  }
  return undefined;
};

describe("the Details card never moves the transcript or the composer", () => {
  it("docked: the card appears in the lane and every box stays put", async () => {
    withMessages();
    const { container } = mount();
    const scope = sessionScope(TAB, undefined);
    const closed = frame(container);
    expect(screen.queryByTestId("details-card")).toBeNull();

    act(() => useSessionDetailsStore.getState().actions.toggle(scope));
    expect(await screen.findByTestId("details-card")).toBeTruthy();
    // Drawn into the dock lane, an absolute layer: not into the row.
    expect(
      container.querySelector("[data-session-dock-lane] [data-testid='details-card']"),
    ).not.toBeNull();
    expect(container.querySelector("[data-chat-row] [data-testid='details-card']")).toBeNull();
    expect(frame(container)).toEqual(closed);
    expect(railMargin(container)).toBeUndefined();

    act(() => useSessionDetailsStore.getState().actions.toggle(scope));
    expect(screen.queryByTestId("details-card")).toBeNull();
    expect(frame(container)).toEqual(closed);
  });

  it("popover (no room to dock): nothing in the panel changes at all", () => {
    WIDTH = 700;
    withMessages();
    const { container } = mount();
    const scope = sessionScope(TAB, undefined);
    const closed = frame(container);
    // No room is kept at this width, so nothing is reserved either.
    expect(closed.row.style).toBeNull();
    expect(container.querySelector("[data-session-dock-lane]")).toBeNull();

    act(() => useSessionDetailsStore.getState().actions.setPopover(scope, true));
    expect(frame(container)).toEqual(closed);
    // The docked open flag is untouched: the popover is its own state.
    expect(useSessionDetailsStore.getState().open).toEqual({});
  });

  it("on an empty session: no reservation, open flag or not", () => {
    useSessionDetailsStore.setState({ open: { [sessionScope(TAB, undefined)]: true } });
    const { container } = mount();
    const composer = container.querySelector("[data-chat-composer-stack]");
    expect(composer?.getAttribute("style")).toBeNull();
    expect(screen.queryByTestId("details-card")).toBeNull();
  });

  it("is per session: a new session in the same tab starts closed", async () => {
    useSessionDetailsStore.setState({ open: { [sessionScope(TAB, undefined)]: true } });
    withMessages("acp-a");
    const { container } = mount();
    // The tab-scoped flag from before the bind moved onto session A.
    expect(useSessionDetailsStore.getState().open).toEqual({ "s:acp-a": true });
    expect(await screen.findByTestId("details-card")).toBeTruthy();
    const open = frame(container);

    act(() => withMessages("acp-b"));
    expect(screen.queryByTestId("details-card")).toBeNull();
    expect(frame(container)).toEqual(open);

    // Back to session A, in the same run: its card is still open.
    act(() => withMessages("acp-a"));
    expect(await screen.findByTestId("details-card")).toBeTruthy();
    expect(frame(container)).toEqual(open);
  });

  it("opening and closing it, in either form, never re-renders the transcript", async () => {
    withMessages();
    mount();
    const scope = sessionScope(TAB, undefined);
    // Let the mount's own effects settle first.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const settled = transcriptRenders.count;
    expect(settled).toBeGreaterThan(0);

    act(() => useSessionDetailsStore.getState().actions.toggle(scope));
    expect(await screen.findByTestId("details-card")).toBeTruthy();
    act(() => useSessionDetailsStore.getState().actions.toggleSection("changes"));
    act(() => useSessionDetailsStore.getState().actions.toggle(scope));
    act(() => useSessionDetailsStore.getState().actions.setPopover(scope, true));
    act(() => useSessionDetailsStore.getState().actions.setPopover(scope, false));
    expect(transcriptRenders.count).toBe(settled);
  });
});
