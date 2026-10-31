import { describe, expect, it } from "vitest";
import type { BranchInfo } from "../stores/git-store";
import {
  buildBaseRefChoices,
  filterBaseRefChoices,
  refOfChoice,
  toggledRef,
} from "./base-ref-choices";

const branch = (name: string, isRemote = false): BranchInfo => ({
  name,
  isCurrent: false,
  isRemote,
  upstream: null,
  ahead: 0,
  behind: 0,
  subject: "",
  date: "",
});

const BRANCHES = [
  branch("feature/x"),
  branch("main"),
  branch("wip"),
  branch("upstream/main", true),
  branch("origin/main", true),
  branch("origin/feature/x", true),
  branch("origin/release", true),
];

describe("buildBaseRefChoices", () => {
  it("pairs each local branch with its remote twin, preferring origin, then lists remote-only refs", () => {
    expect(buildBaseRefChoices(BRANCHES, null)).toEqual([
      {
        id: "local:feature/x",
        label: "feature/x",
        local: "feature/x",
        remote: "origin/feature/x",
      },
      { id: "local:main", label: "main", local: "main", remote: "origin/main" },
      { id: "local:wip", label: "wip", local: "wip", remote: null },
      { id: "remote:upstream/main", label: "upstream/main", local: null, remote: "upstream/main" },
      {
        id: "remote:origin/release",
        label: "origin/release",
        local: null,
        remote: "origin/release",
      },
    ]);
  });

  it("leaves out the branch being compared, keeping its remote copy as remote-only", () => {
    const ids = buildBaseRefChoices(BRANCHES, "feature/x").map((c) => c.id);
    expect(ids).not.toContain("local:feature/x");
    expect(ids).toContain("remote:origin/feature/x");
  });
});

describe("filterBaseRefChoices", () => {
  const choices = buildBaseRefChoices(BRANCHES, null);

  it("matches the label, the local name or the remote ref, ignoring case", () => {
    expect(filterBaseRefChoices(choices, "MAIN").map((c) => c.id)).toEqual([
      "local:main",
      "remote:upstream/main",
    ]);
    expect(filterBaseRefChoices(choices, "origin/feat").map((c) => c.id)).toEqual([
      "local:feature/x",
    ]);
  });

  it("returns every row for an empty or blank query", () => {
    expect(filterBaseRefChoices(choices, "  ")).toBe(choices);
  });
});

describe("a paired row's ref and its remote switch", () => {
  const [, main, wip] = buildBaseRefChoices(BRANCHES, null);

  it("stands for the local branch unless its remote is the one chosen", () => {
    expect(refOfChoice(main!, null)).toBe("main");
    expect(refOfChoice(main!, "main")).toBe("main");
    expect(refOfChoice(main!, "origin/main")).toBe("origin/main");
    expect(refOfChoice(wip!, "origin/main")).toBe("wip");
  });

  it("switches between the local branch and its remote-tracking ref", () => {
    expect(toggledRef(main!, true)).toBe("origin/main");
    expect(toggledRef(main!, false)).toBe("main");
  });
});
