// @vitest-environment happy-dom
//
// The session Details card docks beside the transcript on a wide panel, and
// showing or hiding it must not move the transcript column or the composer.
// The room is reserved from the panel's width, open or closed, and the card is
// an absolute layer drawn into it. This renders the real panel with the app's
// column width (`--atlas-chat-column: 760px`) at a spread of panel widths —
// one too narrow to dock (popover), one where the column narrows, one where it
// slides left, one where it stays centred — and compares every box the column
// is laid out from (the row it is centred in, the column itself, the composer
// stack) with the card closed, open, and closed again.
//
// The panel's children are stubbed: what is under test is the frame.

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
vi.mock("./transcript", () => ({ Transcript: Null }));
vi.mock("@/features/session-context/components/session-details-card", () => ({
  SessionDetailsCard: () => <div data-testid="details-card" />,
}));

import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CONTEXT_CARD_CLEARANCE,
  CONTEXT_CARD_GAP,
  CONTEXT_CARD_WIDTH,
  resolveContextDock,
} from "@/features/session-context/lib/context-dock";
import { useSessionDetailsStore } from "@/features/session-context/stores/session-details-store";
import { sessionScope } from "../lib/session-scope";
import { useChatStore } from "../stores/chat-store";
import { ChatPanel } from "./chat-panel";

const TAB = "tab-1";
const SCOPE = sessionScope(TAB, undefined);
const reset = () =>
  useSessionDetailsStore.setState({ open: {}, popoverFor: null, dockable: {}, view: "main" });
const COLUMN = 760;
let WIDTH = 1000;

beforeEach(() => {
  localStorage.clear();
  WIDTH = 1000;
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
  useChatStore.setState((s) => {
    s.sessions[TAB].messages = [
      { id: "m1", role: "user", content: "hi", timestamp: 0 },
    ] as unknown as (typeof s.sessions)[typeof TAB]["messages"];
  });
  reset();
});
afterEach(() => {
  document.documentElement.style.removeProperty("--atlas-chat-column");
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatPanel tabId={TAB} />
    </QueryClientProvider>,
  );
}

/** Every box the transcript column's position and width come from. */
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

const card = (root: HTMLElement) => root.querySelector("[data-session-details-dock]");

/** A `padding-*` / `margin-*` px value out of an inline style, 0 when unset. */
function px(style: string | null, prop: string): number {
  const match = new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(style ?? "");
  return match ? Number(match[1]) : 0;
}

/** Where the column lands in a panel `width` wide: centred, at most `COLUMN`
 *  wide, in the row less its padding — as the browser lays it out. */
function columnBox(width: number, rowStyle: string | null) {
  const left = px(rowStyle, "padding-left");
  const right = px(rowStyle, "padding-right");
  const box = width - left - right;
  const column = Math.min(COLUMN, box);
  const start = left + (box - column) / 2;
  return { left: start, right: start + column, column };
}

describe("the docked Details card in the chat panel", () => {
  it("never moves the column at any width, whether it docks, narrows, slides or stays centred", () => {
    document.documentElement.style.setProperty("--atlas-chat-column", `${COLUMN}px`);
    // happy-dom does not inherit custom properties into computed style, so
    // the panel's read of the variable is answered as a browser would.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = real(el, pseudo);
      const get = style.getPropertyValue.bind(style);
      style.getPropertyValue = (prop: string) =>
        prop === "--atlas-chat-column"
          ? document.documentElement.style.getPropertyValue(prop)
          : get(prop);
      return style;
    });
    const branches = new Set<string>();
    for (const width of [900, 1100, 1200, 1440]) {
      WIDTH = width;
      reset();
      const { container, unmount } = mount();
      const expected = resolveContextDock(width, COLUMN);
      const docked = useSessionDetailsStore.getState().dockable[TAB] === true;
      expect(docked, `docked at ${width}`).toBe(expected.docked);
      branches.add(
        !expected.docked
          ? "popover"
          : expected.inset > 0
            ? "narrowed"
            : expected.reserve > 0
              ? "slid"
              : "centred",
      );

      const closed = frame(container);
      // Reserved from the width alone, before any card exists.
      expect(px(closed.row.style, "padding-right"), `reserve at ${width}`).toBe(expected.reserve);
      expect(px(closed.row.style, "padding-left"), `inset at ${width}`).toBe(expected.inset);
      expect(px(closed.composer.style, "margin-right")).toBe(expected.reserve);
      const before = columnBox(width, closed.row.style);
      if (expected.docked) {
        // The column ends clear of where the card will be drawn.
        expect(before.right).toBeLessThanOrEqual(
          width - CONTEXT_CARD_GAP - CONTEXT_CARD_WIDTH - CONTEXT_CARD_CLEARANCE,
        );
      }

      act(() => useSessionDetailsStore.getState().actions.toggle(SCOPE));
      expect(card(container) !== null, `card at ${width}`).toBe(expected.docked);
      expect(frame(container), `open at ${width}`).toEqual(closed);
      expect(columnBox(width, frame(container).row.style)).toEqual(before);

      act(() => useSessionDetailsStore.getState().actions.toggle(SCOPE));
      expect(card(container)).toBeNull();
      expect(frame(container), `closed again at ${width}`).toEqual(closed);
      unmount();
    }
    // Every branch of the reservation was laid out, not just the easy one.
    expect([...branches].sort()).toEqual(["centred", "narrowed", "popover", "slid"]);
  });

  it("never moves the transcript column or the composer when toggled", () => {
    const { container } = mount();
    const { reserve } = resolveContextDock(WIDTH, Number.POSITIVE_INFINITY);
    expect(reserve).toBeGreaterThan(0);
    expect(useSessionDetailsStore.getState().dockable[TAB]).toBe(true);

    const closed = frame(container);
    // Reserved while closed: the room exists before the card does.
    expect(closed.row.style).toContain(`padding-right: ${reserve}px`);
    expect(closed.composer.style).toContain(`margin-right: ${reserve}px`);
    expect(card(container)).toBeNull();

    act(() => useSessionDetailsStore.getState().actions.toggle(SCOPE));
    expect(card(container)).not.toBeNull();
    expect(frame(container)).toEqual(closed);

    act(() => useSessionDetailsStore.getState().actions.toggle(SCOPE));
    expect(card(container)).toBeNull();
    expect(frame(container)).toEqual(closed);
  });
});
