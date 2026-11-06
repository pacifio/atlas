// The Details store: the docked card shown by default and hidden per session,
// the popover open for one session at a time, and a card opened before the
// session bound carried over to it without leaking into the tab's next one.

import { beforeEach, describe, expect, it } from "vitest";

import { selectDockedOpen, useSessionDetailsStore } from "./session-details-store";

const actions = () => useSessionDetailsStore.getState().actions;
const state = () => useSessionDetailsStore.getState();

beforeEach(() => {
  useSessionDetailsStore.setState({
    hidden: {},
    popoverFor: null,
    instant: false,
    gitPrompt: null,
  });
});

describe("the docked card", () => {
  it("shows by default, and the toggle hides and shows it per session", () => {
    expect(selectDockedOpen(state(), "s:a")).toBe(true);
    actions().toggle("s:a");
    expect(selectDockedOpen(state(), "s:a")).toBe(false);
    expect(selectDockedOpen(state(), "s:b")).toBe(true);
    actions().toggle("s:a", { instant: true });
    expect(selectDockedOpen(state(), "s:a")).toBe(true);
    expect(state().instant).toBe(true);
  });
});

describe("the popover", () => {
  it("is open for one session at a time, and closing another session's is a no-op", () => {
    actions().setPopover("s:a", true);
    actions().setPopover("s:b", true);
    expect(state().popoverFor).toBe("s:b");
    actions().setPopover("s:a", false);
    expect(state().popoverFor).toBe("s:b");
    actions().setPopover("s:b", false);
    expect(state().popoverFor).toBeNull();
  });

  it("close hides the card in either form", () => {
    actions().setPopover("s:a", true);
    actions().close("s:a");
    expect(state().popoverFor).toBeNull();
    expect(selectDockedOpen(state(), "s:a")).toBe(false);
  });
});

describe("adopt", () => {
  it("moves a tab-scoped hide and popover onto the session, and clears the tab", () => {
    actions().toggle("t:tab-1");
    actions().setPopover("t:tab-1", true);
    actions().adopt("t:tab-1", "s:acp-1");
    expect(state().hidden).toEqual({ "s:acp-1": true });
    expect(state().popoverFor).toBe("s:acp-1");
  });

  it("changes nothing when the tab scope holds nothing", () => {
    const before = state();
    actions().adopt("t:tab-1", "s:acp-1");
    expect(state()).toBe(before);
  });
});

describe("prompts", () => {
  it("holds one git prompt at a time", () => {
    const prompt = {
      kind: "commit" as const,
      path: "/work/acme",
      action: "commit_push" as const,
      sessionId: null,
      featureBranch: false,
    };
    actions().promptGitAction(prompt);
    expect(state().gitPrompt).toEqual(prompt);
    actions().promptGitAction(null);
    expect(state().gitPrompt).toBeNull();
  });
});
