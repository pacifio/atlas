// @vitest-environment happy-dom
//
// The Options pill is always on screen now, so what it SAYS is the whole
// contract. It used to be gated on `configOptions.length > 0`, which meant it
// was absent for the three or four seconds an agent takes to spawn, handshake
// and answer `session/new` — and the composer re-flowed when it popped in.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "../stores/chat-store";
import { saveCachedAcpConfigOptions } from "../lib/acp-config-options-cache";
import { ComposerOptionsPill } from "./composer-options-pill";

const TAB = "tab-1";

const knob = {
  id: "thought",
  name: "Thinking",
  category: "thought_level",
  type: "select",
  currentValue: "high",
  options: [{ value: "high", name: "High" }],
};

beforeEach(() => {
  // Vitest runs with `globals: false`, so testing-library's auto-cleanup never
  // registers — without this the previous test's DOM is still mounted and every
  // query below finds it first.
  cleanup();
  localStorage.clear();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
});

/** The pill's own button. The panel stays MOUNTED at height 0 and holds the
 *  knob buttons, so "the button" has to be pinned to the pill: only the pill
 *  carries `aria-busy`. */
const pill = () => document.querySelector("button[aria-busy]") as HTMLButtonElement;

describe("ComposerOptionsPill", () => {
  it("renders a loading pill when nothing is known about this agent yet", () => {
    render(<ComposerOptionsPill tabId={TAB} />);
    // Not absent — that was the bug. Present, labelled, and not yet clickable.
    expect(pill()).toBeTruthy();
    expect(pill().getAttribute("aria-busy")).toBe("true");
    expect(pill().disabled).toBe(true);
    // "Options", never "Default": a verdict must not be paired with a spinner.
    expect(pill().textContent).toContain("Options");
  });

  it("renders cached knobs instantly, with no loading state", () => {
    // The cold-start path: a restored tab paints its transcript without booting
    // the agent, so the cache is the ONLY source until a live session speaks.
    saveCachedAcpConfigOptions("claude-code", [knob]);
    render(<ComposerOptionsPill tabId={TAB} />);

    expect(pill().textContent).toContain("Options");
    expect(pill().getAttribute("aria-busy")).toBe("false");
    expect(pill().disabled).toBe(false);
  });

  it("renders Default when the agent is known to advertise no knobs", () => {
    // An EMPTY cached list is a verdict, not a miss — so this settles instantly
    // rather than spinning to re-learn an answer that never changes.
    saveCachedAcpConfigOptions("claude-code", []);
    render(<ComposerOptionsPill tabId={TAB} />);

    expect(pill().textContent).toContain("Default");
    expect(pill().getAttribute("aria-busy")).toBe("false");
    expect(screen.getByText("Agent loaded with default configuration.")).toBeTruthy();
  });

  it("settles to Default the moment a live session says it has no knobs", () => {
    render(<ComposerOptionsPill tabId={TAB} />);
    expect(pill().getAttribute("aria-busy")).toBe("true");

    act(() => useChatStore.getState().actions.setAcpConfigOptions(TAB, []));
    expect(pill().getAttribute("aria-busy")).toBe("false");
    expect(pill().textContent).toContain("Default");
  });

  it("a live list overrides a cached empty verdict", () => {
    // Background reconciliation: the cache paints instantly, and the live
    // session's answer replaces it without the user doing anything.
    saveCachedAcpConfigOptions("claude-code", []);
    render(<ComposerOptionsPill tabId={TAB} />);
    expect(pill().textContent).toContain("Default");

    act(() => useChatStore.getState().actions.setAcpConfigOptions(TAB, [knob]));
    expect(pill().textContent).toContain("Options");
  });

  it("re-reads the cache when the tab switches agents", () => {
    // The bug: `acpConfigOptions` was the one per-agent list the switch never
    // reset, so the pill kept showing the PREVIOUS agent's state — a settled
    // "Default" carried over from an agent with no knobs, which then snapped
    // to "Options" with no loading in between when the new binding spoke.
    saveCachedAcpConfigOptions("claude-code", [knob]);
    useChatStore.getState().actions.switchChatAgent(TAB, "cersei");
    // The user's path: the native agent's LIVE session settles on "no knobs",
    // so there is a real value in the store to go stale.
    useChatStore.getState().actions.setAcpConfigOptions(TAB, []);

    render(<ComposerOptionsPill tabId={TAB} />);
    expect(pill().textContent).toContain("Default");

    act(() => useChatStore.getState().actions.switchChatAgent(TAB, "claude-code"));
    expect(pill().textContent).toContain("Options");
  });

  it("shows loading — not the old agent's answer — when switching to an unknown agent", () => {
    saveCachedAcpConfigOptions("cersei", [knob]);
    useChatStore.getState().actions.switchChatAgent(TAB, "cersei");
    render(<ComposerOptionsPill tabId={TAB} />);
    expect(pill().getAttribute("aria-busy")).toBe("false");

    // Never heard from this one: a cache MISS must land on the loading state,
    // not inherit whatever the previous agent advertised.
    act(() => useChatStore.getState().actions.switchChatAgent(TAB, "opencode"));
    expect(pill().getAttribute("aria-busy")).toBe("true");
    expect(pill().textContent).toContain("Options");
  });

  it("drops a live list when the tab switches agents", () => {
    // The dangerous half: another agent's knobs staying clickable would write
    // `set_config_option` for ids the new agent never advertised.
    useChatStore.getState().actions.setAcpConfigOptions(TAB, [knob]);
    render(<ComposerOptionsPill tabId={TAB} />);
    expect(pill().textContent).toContain("Options");

    act(() => useChatStore.getState().actions.switchChatAgent(TAB, "opencode"));
    expect(useChatStore.getState().sessions[TAB].acpConfigOptions).toBeUndefined();
    expect(pill().getAttribute("aria-busy")).toBe("true");
  });

  it("reads Default when every advertised knob belongs to another pill", () => {
    // `mode` and `model` are owned by their own pickers, so an agent whose only
    // knob is a model select has nothing left to offer here — and must not
    // present an Options pill that opens onto an empty list.
    saveCachedAcpConfigOptions("claude-code", [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "opus",
        options: [{ value: "opus", name: "Opus" }],
      },
    ]);
    render(<ComposerOptionsPill tabId={TAB} />);
    expect(pill().textContent).toContain("Default");
  });
});
