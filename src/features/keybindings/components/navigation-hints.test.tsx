// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const platform = vi.hoisted(() => ({ mac: true }));
vi.mock("@/lib/platform", () => ({
  get isMac() {
    return platform.mac;
  },
  get isWindows() {
    return !platform.mac;
  },
  isLinux: false,
}));

import { useActionHotkeys } from "@/hooks/use-hotkey";
import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";
import { useHintStore } from "@/features/hint-nav/stores/hint-store";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { resolveProfile } from "../lib/resolve";
import type { KeybindingProfile } from "../lib/types";
import type { ActionHandlers } from "../lib/action-registry";
import { useScopedHotkeys } from "../lib/use-scoped-hotkeys";
import { useNavigationHint } from "../lib/use-navigation-hint";
import {
  NAVIGATION_HINT_DELAY,
  splitNavigationActions,
  tabNavigationActions,
} from "../lib/navigation-hints";
import { NavigationHints } from "./navigation-hints";

const tab = (id: string, groupId = "main"): Tab => ({
  id,
  groupId,
  type: "settings",
  title: id,
  closable: true,
  dirty: false,
  data: {},
});
const overlay = () => document.querySelector("[data-navigation-hints]");
const badge = (action: string) =>
  document.querySelector('[data-navigation-action="' + action + '"]');
const primary = () => ({ metaKey: platform.mac, ctrlKey: !platform.mac });
const primaryCode = () => (platform.mac ? "MetaLeft" : "ControlLeft");
let targetRects = new WeakMap<HTMLElement, DOMRect>();
function down(code: string, options: KeyboardEventInit = primary()) {
  const event = new KeyboardEvent("keydown", {
    key: code,
    code,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  // happy-dom reports AltGraph for every Alt press. These events model a
  // physical Alt/Option key; the separate AltGraph case supplies its own event.
  const getModifierState = event.getModifierState.bind(event);
  vi.spyOn(event, "getModifierState").mockImplementation((key) =>
    key === "AltGraph" ? false : getModifierState(key),
  );
  fireEvent(document.activeElement ?? window, event);
  return event;
}
function up(code = primaryCode(), options: KeyboardEventInit = {}) {
  fireEvent.keyUp(window, { key: code, code, ...options });
}
function reveal(options: KeyboardEventInit = primary(), code = primaryCode()) {
  down(code, options);
  act(() => vi.advanceTimersByTime(NAVIGATION_HINT_DELAY));
}
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40);
  });
}
function rebind(bindings: KeybindingProfile["bindings"], basedOn?: string) {
  act(() => {
    useKeybindingsStore.setState({
      resolved: resolveProfile({ id: "custom", name: "Custom", bindings, basedOn }),
    });
  });
}

/** Real dispatchers + the real layout store, with small controls instead of lazy app panels. */
function Harness({ children }: { children?: ReactNode }) {
  const tabs = useLayoutStore.use.tabs();
  const groups = useLayoutStore.use.groupOrder();
  const focused = useLayoutStore.use.focusedGroupId();
  const active = useLayoutStore.use.activeByGroup();
  const actions = useLayoutStore.use.actions();
  const navigationHint = useNavigationHint();
  const handlers: ActionHandlers = {
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        "tabs.focus" + (i + 1),
        () => actions.activateTabByIndex(i === 8 ? -1 : i),
      ]),
    ),
    "tabs.prev": () => actions.cycleTab(-1),
    "tabs.next": () => actions.cycleTab(1),
    "split.focusLeft": () => actions.focusAdjacentGroup(-1),
    "split.focusRight": () => actions.focusAdjacentGroup(1),
    "panels.left": actions.toggleLeftPanel,
    "panels.right": actions.toggleRightPanel,
  };
  useActionHotkeys(handlers);
  return (
    <>
      <NavigationHints />
      <input aria-label="Editor" />
      <button {...navigationHint(["panels.left"])} onClick={actions.toggleLeftPanel}>
        Files
      </button>
      <button {...navigationHint(["panels.right"])} onClick={actions.toggleRightPanel}>
        Source Control
      </button>
      {groups.map((group) => {
        const local = tabs.filter((t) => t.groupId === group);
        const current = local.findIndex((t) => t.id === active[group]);
        return (
          <div
            key={group}
            role="group"
            aria-label={group}
            {...navigationHint(splitNavigationActions(group, groups, focused))}
          >
            {local.map((t, index) => (
              <button
                key={t.id}
                role="tab"
                {...navigationHint(
                  group === focused ? tabNavigationActions(index, local.length, current) : [],
                )}
                onClick={() => actions.setActiveTab(t.id)}
              >
                {t.title}
              </button>
            ))}
          </div>
        );
      })}
      {children}
    </>
  );
}

beforeEach(() => {
  platform.mac = true;
  vi.useFakeTimers();
  targetRects = new WeakMap();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return targetRects.get(this) ?? new DOMRect(20, 40, 160, 28);
    },
  );
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  useKeybindingsStore.setState({ recording: false, resolved: resolveProfile(undefined) });
  useHintStore.setState({ open: false });
  useLayoutStore.setState({
    ...useLayoutStore.getInitialState(),
    tabs: [tab("a"), tab("b"), tab("c"), tab("r1", "right"), tab("r2", "right")],
    groupOrder: ["main", "right", "empty"],
    focusedGroupId: "main",
    activeByGroup: { main: "a", right: "r1", empty: null },
    activeTabId: "a",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each([true, false])("modifier hints (mac=%s)", (mac) => {
  beforeEach(() => {
    platform.mac = mac;
  });

  it("waits before revealing, preserves focus and events, then hides immediately on release", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Editor");
    input.focus();
    const event = down(primaryCode());
    act(() => vi.advanceTimersByTime(NAVIGATION_HINT_DELAY - 1));
    expect(overlay()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(badge("tabs.focus2")?.textContent).toBe("2");
    expect(overlay()?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay()?.classList.contains("pointer-events-none")).toBe(true);
    expect(overlay()?.querySelector("button, input, [tabindex]")).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole("tab", { name: "b" }).getAttribute("aria-keyshortcuts")).toContain(
      mac ? "Meta+2" : "Control+2",
    );
    up();
    expect(overlay()).toBeNull();
  });

  it("never flashes for a quick modifier press or starts from an auto-repeat", () => {
    render(<Harness />);
    down(primaryCode());
    up();
    act(() => vi.advanceTimersByTime(800));
    expect(overlay()).toBeNull();
    down(primaryCode(), { ...primary(), repeat: true });
    act(() => vi.advanceTimersByTime(800));
    expect(overlay()).toBeNull();
  });

  it.each([false, true])(
    "suppresses unrelated shortcuts until release (already visible=%s)",
    (visible) => {
      render(<Harness />);
      down(primaryCode());
      if (visible) act(() => vi.advanceTimersByTime(NAVIGATION_HINT_DELAY));
      down("KeyS");
      act(() => vi.advanceTimersByTime(800));
      up("KeyS", primary());
      expect(overlay()).toBeNull();
      up();
      reveal();
      expect(overlay()).not.toBeNull();
    },
  );

  it("changes caps with Shift and routes the labelled panel key through the existing handler", () => {
    render(<Harness />);
    reveal();
    expect(badge("panels.left")?.textContent).toBe("B");
    expect(badge("panels.right")).toBeNull();
    down("ShiftLeft", { ...primary(), shiftKey: true });
    expect(badge("panels.left")).toBeNull();
    expect(badge("panels.right")?.textContent).toBe("B");
    const previous = useLayoutStore.getState().rightPanel.visible;
    down("KeyB", { ...primary(), shiftKey: true });
    expect(useLayoutStore.getState().rightPanel.visible).toBe(!previous);
    up("ShiftLeft", primary());
    expect(badge("panels.left")?.textContent).toBe("B");
  });

  it("switches only the focused split, keeps 9 as last, and remaps after focusing another pane", async () => {
    render(<Harness />);
    reveal();
    down("Digit2");
    expect(useLayoutStore.getState().activeTabId).toBe("b");
    down("Digit9");
    expect(useLayoutStore.getState().activeTabId).toBe("c");
    expect(useLayoutStore.getState().activeByGroup.right).toBe("r1");
    up();
    down("Quote", { altKey: true });
    expect(useLayoutStore.getState().focusedGroupId).toBe("right");
    expect(useLayoutStore.getState().activeTabId).toBe("r1");
    up("AltLeft");
    reveal();
    await settle();
    expect(badge("tabs.focus3")).toBeNull();
    expect(badge("tabs.focus2")).not.toBeNull();
    down("Digit2");
    expect(useLayoutStore.getState().activeTabId).toBe("r2");
    expect(useLayoutStore.getState().activeByGroup.main).toBe("c");
    up();
    down("Quote", { altKey: true });
    await settle();
    expect(useLayoutStore.getState().focusedGroupId).toBe("empty");
    expect(useLayoutStore.getState().activeTabId).toBeNull();
    up("AltLeft");
    rebind({ "split.focusLeft": ["cmd+alt+left"], "split.focusRight": ["cmd+alt+right"] });
    reveal({ ...primary(), altKey: true });
    expect(badge("split.focusLeft")).not.toBeNull();
    expect(badge("split.focusRight")).toBeNull();
    down("ArrowLeft", { ...primary(), altKey: true });
    expect(useLayoutStore.getState().focusedGroupId).toBe("right");
    expect(useLayoutStore.getState().activeTabId).toBe("r2");
  });

  it("updates visible caps and accessible shortcuts after rebinding or unbinding", () => {
    render(<Harness />);
    reveal();
    rebind({ "tabs.focus2": ["cmd+x"], "panels.left": null });
    expect(badge("tabs.focus2")?.textContent).toBe("X");
    expect(badge("panels.left")).toBeNull();
    expect(screen.getByRole("tab", { name: "b" }).getAttribute("aria-keyshortcuts")).toContain(
      mac ? "Meta+X" : "Control+X",
    );
    down("KeyX");
    expect(useLayoutStore.getState().activeTabId).toBe("b");
  });

  it.each(["recording", "hint-navigation"])(
    "yields to %s, even if it opens during a hold",
    (owner) => {
      render(<Harness />);
      reveal();
      act(() => {
        if (owner === "recording") useKeybindingsStore.setState({ recording: true });
        else useHintStore.setState({ open: true });
      });
      expect(overlay()).toBeNull();
      act(() => {
        useKeybindingsStore.setState({ recording: false });
        useHintStore.setState({ open: false });
        vi.advanceTimersByTime(800);
      });
      expect(overlay()).toBeNull();
      up();
      reveal();
      expect(overlay()).not.toBeNull();
    },
  );

  it.each(["blur", "pointerdown", "compositionstart"])("dismisses on %s", (type) => {
    render(<Harness />);
    reveal();
    fireEvent(window, new Event(type, { bubbles: true }));
    expect(overlay()).toBeNull();
    act(() => vi.advanceTimersByTime(800));
    expect(overlay()).toBeNull();
  });
});

it("honors macOS Control-based presets without advertising their digits on Command", () => {
  rebind({}, "vscode");
  render(<Harness />);
  reveal();
  expect(badge("tabs.focus1")).toBeNull();
  up();
  reveal({ ctrlKey: true }, "ControlLeft");
  expect(badge("tabs.focus2")?.textContent).toBe("2");
  down("Digit2", { ctrlKey: true });
  expect(useLayoutStore.getState().activeTabId).toBe("b");
});

it("does not trigger on Windows' Win key or during AltGraph input", () => {
  platform.mac = false;
  render(<Harness />);
  reveal({ metaKey: true }, "MetaLeft");
  expect(overlay()).toBeNull();
  up("MetaLeft");
  const event = new KeyboardEvent("keydown", { code: "ControlLeft", ctrlKey: true, altKey: true });
  vi.spyOn(event, "getModifierState").mockImplementation((key) => key === "AltGraph");
  fireEvent(window, event);
  act(() => vi.advanceTimersByTime(800));
  expect(overlay()).toBeNull();
});

it("cancels a pending hold when the document becomes hidden", () => {
  render(<Harness />);
  down(primaryCode());
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  act(() => vi.advanceTimersByTime(800));
  expect(overlay()).toBeNull();
});

it("ignores a primary chord reported as IME composition", () => {
  render(<Harness />);
  down(primaryCode(), { ...primary(), isComposing: true });
  act(() => vi.advanceTimersByTime(800));
  expect(overlay()).toBeNull();
});

it("drops timers and listeners when unmounted during a hold", () => {
  const first = render(<Harness />);
  down(primaryCode());
  first.unmount();
  act(() => vi.advanceTimersByTime(800));
  render(<Harness />);
  down(primaryCode(), { ...primary(), repeat: true });
  act(() => vi.advanceTimersByTime(800));
  expect(overlay()).toBeNull();
  reveal();
  expect(document.querySelectorAll("[data-navigation-hints]")).toHaveLength(1);
});

it("suppresses a visible menu, including one that appears after the delay", async () => {
  const { rerender } = render(
    <Harness>
      <div role="menu">Menu</div>
    </Harness>,
  );
  reveal();
  expect(overlay()).toBeNull();
  up();
  rerender(<Harness />);
  reveal();
  expect(overlay()).not.toBeNull();
  rerender(
    <Harness>
      <div role="menu">Menu</div>
    </Harness>,
  );
  await settle();
  expect(overlay()).toBeNull();
  rerender(<Harness />);
  await settle();
  expect(overlay()).toBeNull();
});

it("omits keys claimed by a scoped surface and leaves its dispatch intact", async () => {
  const handled = vi.fn();
  function TerminalScope() {
    useScopedHotkeys({ tabId: "a", handlers: { "terminal.nextTab": handled } });
    return null;
  }
  rebind({ "terminal.nextTab": ["cmd+2"] });
  render(
    <Harness>
      <TerminalScope />
    </Harness>,
  );
  reveal();
  expect(badge("tabs.focus2")).toBeNull();
  down("Digit2");
  expect(handled).toHaveBeenCalledTimes(1);
  expect(useLayoutStore.getState().activeTabId).toBe("a");
  expect(overlay()).toBeNull();
  up();
  act(() => useLayoutStore.getState().actions.setActiveTab("b"));
  reveal();
  await settle();
  expect(badge("tabs.focus2")?.textContent).toBe("2");
  down("Digit2");
  expect(handled).toHaveBeenCalledTimes(1);
});

it("updates when a scoped handler mounts while the modifier remains held", async () => {
  function Scope() {
    useScopedHotkeys({ handlers: { "terminal.nextTab": () => {} } });
    return null;
  }
  rebind({ "terminal.nextTab": ["cmd+2"] });
  const { rerender } = render(<Harness />);
  reveal();
  expect(badge("tabs.focus2")).not.toBeNull();
  rerender(
    <Harness>
      <Scope />
    </Harness>,
  );
  await settle();
  expect(badge("tabs.focus2")).toBeNull();
  rerender(<Harness />);
  await settle();
  expect(badge("tabs.focus2")).not.toBeNull();
});

it("removes hidden or disabled destinations and follows moved controls on scroll", async () => {
  render(<Harness />);
  reveal();
  const target = screen.getByRole("tab", { name: "b" });
  target.hidden = true;
  await settle();
  expect(badge("tabs.focus2")).toBeNull();
  target.hidden = false;
  target.setAttribute("disabled", "");
  await settle();
  expect(badge("tabs.focus2")).toBeNull();
  target.removeAttribute("disabled");
  targetRects.set(target, new DOMRect(200, 50, 100, 28));
  fireEvent.scroll(window);
  await settle();
  expect((badge("tabs.focus2") as HTMLElement)?.style.left).toBe("202px");
});

it("does not label tabs clipped by a horizontal scroller or by the viewport", () => {
  render(<Harness />);
  const group = screen.getByRole("group", { name: "main" });
  group.style.overflowX = "auto";
  targetRects.set(group, new DOMRect(20, 40, 160, 28));
  const target = screen.getByRole("tab", { name: "b" });
  targetRects.set(target, new DOMRect(160, 40, 100, 28));
  const last = screen.getByRole("tab", { name: "c" });
  targetRects.set(last, new DOMRect(window.innerWidth, 40, 100, 28));
  reveal();
  expect(badge("tabs.focus1")).not.toBeNull();
  expect(badge("tabs.focus2")).toBeNull();
  expect(badge("tabs.focus3")).toBeNull();
});
