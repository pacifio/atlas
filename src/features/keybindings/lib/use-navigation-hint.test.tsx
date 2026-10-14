// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { memo, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ isMac: true, isWindows: false, isLinux: false }));

import { useActionHotkeys } from "@/hooks/use-hotkey";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useHintStore } from "@/features/hint-nav/stores/hint-store";
import { useKeybindingsStore } from "../stores/keybindings-store";
import { useNavigationHint } from "./use-navigation-hint";
import { useScopedHotkeys } from "./use-scoped-hotkeys";
import { resolveProfile } from "./resolve";
import type { ActionHandlers } from "./action-registry";

const handler = () => {};
const Target = memo(function Target() {
  const hint = useNavigationHint();
  return <button {...hint(["tabs.focus1"])}>First tab</button>;
});
function Owner({ handlers }: { handlers: ActionHandlers }) {
  useActionHotkeys(handlers);
  return null;
}
const shortcut = () =>
  screen.getByRole("button", { name: "First tab" }).getAttribute("aria-keyshortcuts");
const overrides = () => {
  useKeybindingsStore.setState({
    resolved: resolveProfile({
      id: "custom",
      name: "Custom",
      bindings: { "nav.commandPalette": ["cmd+1"], "terminal.nextTab": ["cmd+1"] },
    }),
  });
};

beforeEach(() => {
  useKeybindingsStore.setState({ recording: false, resolved: resolveProfile(undefined) });
  useHintStore.setState({ open: false });
  useLayoutStore.setState({ activeTabId: "a" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("live accessible navigation shortcuts", () => {
  it("updates a mounted, memoized target when an owner registers in an effect or unmounts", () => {
    const { rerender } = render(
      <>
        <Target />
      </>,
    );
    expect(shortcut()).toBeNull();
    rerender(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
      </>,
    );
    expect(shortcut()).toBe("Meta+1");
    rerender(
      <>
        <Target />
      </>,
    );
    expect(shortcut()).toBeNull();
  });

  it("follows handler membership changes without re-registering the owner", () => {
    overrides();
    const { rerender } = render(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
      </>,
    );
    // The earlier palette binding has no handler, so dispatch skips it.
    expect(shortcut()).toBe("Meta+1");
    rerender(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler, "nav.commandPalette": handler }} />
      </>,
    );
    expect(shortcut()).toBeNull();
    rerender(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
      </>,
    );
    expect(shortcut()).toBe("Meta+1");
  });

  it("tracks active-tab scope ownership even when no target DOM changes", () => {
    function Scope() {
      useScopedHotkeys({ tabId: "a", handlers: { "terminal.nextTab": handler } });
      return null;
    }
    overrides();
    render(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
        <Scope />
      </>,
    );
    expect(shortcut()).toBeNull();
    act(() => useLayoutStore.setState({ activeTabId: "b" }));
    expect(shortcut()).toBe("Meta+1");
    act(() => useLayoutStore.setState({ activeTabId: "a" }));
    expect(shortcut()).toBeNull();
  });

  it("tracks scoped mount and unmount without needing visible keycaps", () => {
    function Scope() {
      useScopedHotkeys({ handlers: { "terminal.nextTab": handler } });
      return null;
    }
    overrides();
    const { rerender } = render(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
      </>,
    );
    expect(shortcut()).toBe("Meta+1");
    rerender(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
        <Scope />
      </>,
    );
    expect(shortcut()).toBeNull();
    rerender(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
      </>,
    );
    expect(shortcut()).toBe("Meta+1");
  });

  it("follows DOM focus entering and leaving a focus-within scope", () => {
    function Scope() {
      const root = useRef<HTMLDivElement>(null);
      useScopedHotkeys({
        rootRef: root,
        requireFocusWithin: true,
        handlers: { "terminal.nextTab": handler },
      });
      return (
        <div ref={root}>
          <input aria-label="Scoped input" />
        </div>
      );
    }
    overrides();
    render(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
        <Scope />
        <input aria-label="Outside" />
      </>,
    );
    expect(shortcut()).toBe("Meta+1");
    Object.defineProperty(screen.getByLabelText("Scoped input").parentElement, "offsetParent", {
      value: document.body,
      configurable: true,
    });
    act(() => screen.getByLabelText("Scoped input").focus());
    expect(shortcut()).toBeNull();
    act(() => screen.getByLabelText("Outside").focus());
    expect(shortcut()).toBe("Meta+1");
  });

  it("refreshes resolved keys while no modifier is held", () => {
    render(
      <>
        <Target />
        <Owner handlers={{ "tabs.focus1": handler }} />
      </>,
    );
    expect(shortcut()).toBe("Meta+1");
    act(() =>
      useKeybindingsStore.setState({
        resolved: resolveProfile({
          id: "custom",
          name: "Custom",
          bindings: { "tabs.focus1": ["cmd+x"] },
        }),
      }),
    );
    expect(shortcut()).toBe("Meta+X");
  });

  it.each(["recording", "hint navigation"])(
    "omits shortcuts while %s owns the keyboard",
    (owner) => {
      render(
        <>
          <Target />
          <Owner handlers={{ "tabs.focus1": handler }} />
        </>,
      );
      expect(shortcut()).toBe("Meta+1");
      act(() => {
        if (owner === "recording") useKeybindingsStore.setState({ recording: true });
        else useHintStore.setState({ open: true });
      });
      expect(shortcut()).toBeNull();
      act(() => {
        useKeybindingsStore.setState({ recording: false });
        useHintStore.setState({ open: false });
      });
      expect(shortcut()).toBe("Meta+1");
    },
  );
});
