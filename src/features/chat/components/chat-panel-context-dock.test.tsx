// @vitest-environment happy-dom
//
// The session Details card docks beside the transcript on a wide panel. While
// it is closed the transcript column and the composer centre in the whole
// panel — no empty lane is kept for a card that is not there — and while it
// is open they leave it the room `resolveContextDock` answers for the panel's
// width; the card is an absolute layer drawn into that room. This renders the
// real panel with the app's column width (`--atlas-chat-column: 760px`) at a
// spread of panel widths — one too narrow to dock (popover), one where the
// column narrows, one where it slides left, one where it stays centred — and
// reads every box the column is laid out from (the row it is centred in, the
// column itself, the composer stack) with the card closed, open, and closed
// again.
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
// Starts hidden, so the first toggle shows it: the docked card is on by
// default, and these tests measure the panel with and without it.
const reset = () =>
  useSessionDetailsStore.setState({
    hidden: { [SCOPE]: true },
    popoverFor: null,
  });
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
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-chat-drop-zone") ? WIDTH : 0;
  });
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

const card = (root: HTMLElement) => root.querySelector("[data-session-details-dock]");

/** The room the panel keeps for the card: its width-derived variables, and
 *  whether it applies them (`data-dock-open`, while the card is open). The
 *  row and composer take it as padding / margin through `group-data` classes,
 *  which happy-dom does not evaluate, so this reads the inputs to them. */
function room(root: HTMLElement) {
  const zone = root.querySelector<HTMLElement>("[data-chat-drop-zone]")!;
  const read = (name: string) => {
    const v = zone.style.getPropertyValue(name);
    return v ? Number.parseFloat(v) : 0;
  };
  const open = zone.hasAttribute("data-dock-open");
  return {
    open,
    reserve: read("--chat-dock-reserve"),
    inset: read("--chat-dock-inset"),
    /** What the row is padded by, as the browser applies it. */
    applied: open
      ? { left: read("--chat-dock-inset"), right: read("--chat-dock-reserve") }
      : { left: 0, right: 0 },
  };
}

/** The row and composer carry the classes that turn the flag into room. */
function wired(root: HTMLElement) {
  const row = root.querySelector("[data-chat-row]")!.className;
  const composer = root.querySelector("[data-chat-composer-stack]")!.className;
  expect(row).toContain("group-data-[dock-open]/dock:pr-(--chat-dock-reserve)");
  expect(row).toContain("group-data-[dock-open]/dock:pl-(--chat-dock-inset)");
  expect(composer).toContain("group-data-[dock-open]/dock:mr-(--chat-dock-reserve)");
  expect(composer).toContain("group-data-[dock-open]/dock:ml-(--chat-dock-inset)");
}

/** Where the column lands given the row's applied padding. */
function columnIn(width: number, applied: { left: number; right: number }) {
  const box = width - applied.left - applied.right;
  const column = Math.min(COLUMN, box);
  const start = applied.left + (box - column) / 2;
  return { left: start, right: start + column, column };
}

describe("the docked Details card in the chat panel", () => {
  it("centres the column while the card is closed and clears the open card at any width", () => {
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
      wired(container);
      const expected = resolveContextDock(width, COLUMN);
      branches.add(
        !expected.docked
          ? "popover"
          : expected.inset > 0
            ? "narrowed"
            : expected.reserve > 0
              ? "slid"
              : "centred",
      );

      // Closed: the room is known from the width but not applied, so the
      // column centres in the whole panel.
      const closed = room(container);
      expect(closed.open, `closed flag at ${width}`).toBe(false);
      expect(closed.reserve, `reserve var at ${width}`).toBe(expected.reserve);
      expect(closed.inset, `inset var at ${width}`).toBe(expected.inset);
      const centred = columnIn(width, closed.applied);
      expect(centred.left, `centred at ${width}`).toBe((width - centred.column) / 2);

      // Open: applied, and the column ends clear of the card.
      act(() => useSessionDetailsStore.getState().actions.toggle(SCOPE));
      expect(card(container) !== null, `card at ${width}`).toBe(expected.docked);
      const open = room(container);
      expect(open.open, `open flag at ${width}`).toBe(expected.docked);
      if (expected.docked) {
        expect(columnIn(width, open.applied).right).toBeLessThanOrEqual(
          width - CONTEXT_CARD_GAP - CONTEXT_CARD_WIDTH - CONTEXT_CARD_CLEARANCE,
        );
      }

      act(() => useSessionDetailsStore.getState().actions.toggle(SCOPE));
      expect(card(container)).toBeNull();
      expect(room(container).open, `closed again at ${width}`).toBe(false);
      unmount();
    }
    // Every branch of the reservation was laid out, not just the easy one.
    expect([...branches].sort()).toEqual(["centred", "narrowed", "popover", "slid"]);
  });

  it("applies the room only while the card is open", () => {
    const { container } = mount();
    wired(container);
    const { reserve } = resolveContextDock(WIDTH, Number.POSITIVE_INFINITY);
    expect(reserve).toBeGreaterThan(0);

    expect(room(container)).toMatchObject({ open: false, reserve });
    expect(card(container)).toBeNull();

    act(() => useSessionDetailsStore.getState().actions.toggle(SCOPE));
    expect(card(container)).not.toBeNull();
    expect(room(container)).toMatchObject({ open: true, reserve });

    act(() => useSessionDetailsStore.getState().actions.toggle(SCOPE));
    expect(card(container)).toBeNull();
    expect(room(container)).toMatchObject({ open: false, reserve });
  });
});
