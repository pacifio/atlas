// The Commit row's run state: phases replace the output line, output lands
// only on the run streaming that op, and finishing leaves a confirmation or
// (on failure) nothing.

import { beforeEach, describe, expect, it } from "vitest";

import { formatElapsed } from "../components/commit-row";
import { useGitActionStore } from "./git-action-store";

const PATH = "/work/acme";
const actions = () => useGitActionStore.getState().actions;
const state = () => useGitActionStore.getState();

beforeEach(() => useGitActionStore.setState({ runs: {}, success: {} }));

describe("git action runs", () => {
  it("streams output to the run whose op it is, and a new phase clears the line", () => {
    actions().start(PATH, "Committing…");
    actions().phase(PATH, "Committing…", "op-1");
    actions().output("op-1", "  husky > pre-commit  ");
    actions().output("op-other", "not ours");
    actions().output("op-1", "   ");
    expect(state().runs[PATH]).toMatchObject({ label: "Committing…", line: "husky > pre-commit" });
    actions().phase(PATH, "Pushing…", "op-2");
    expect(state().runs[PATH]).toMatchObject({ label: "Pushing…", opId: "op-2", line: null });
  });

  it("finishing with news leaves a confirmation, without leaves nothing", () => {
    actions().start(PATH, "Pushing…");
    actions().finish(PATH, { title: "Pushed", description: "main" });
    expect(state().runs[PATH]).toBeUndefined();
    expect(state().success[PATH]).toEqual({ title: "Pushed", description: "main" });

    // A new run clears the old confirmation; a failed one leaves none.
    actions().start(PATH, "Pushing…");
    expect(state().success[PATH]).toBeUndefined();
    actions().finish(PATH, null);
    expect(state().runs).toEqual({});
    expect(state().success).toEqual({});
  });
});

describe("formatElapsed", () => {
  it("counts seconds, then minutes and seconds", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(12_900)).toBe("12s");
    expect(formatElapsed(63_000)).toBe("1m 3s");
  });
});
