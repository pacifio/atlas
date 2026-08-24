// @vitest-environment happy-dom
//
// Persisted per-agent config-option LIST cache (#36). The advertised knob list
// died with the process while its siblings (modes, models) survived restart via
// their caches — so the Options pill vanished until the next live session.

import { beforeEach, describe, expect, it } from "vitest";
import { loadCachedAcpConfigOptions, saveCachedAcpConfigOptions } from "./acp-config-options-cache";

beforeEach(() => localStorage.clear());

const effort = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "default",
  options: [{ value: "default", name: "Default" }],
};

describe("round trip", () => {
  it("hands back what a live session advertised, per agent", () => {
    saveCachedAcpConfigOptions("claude-acp", [effort]);
    saveCachedAcpConfigOptions("codex-acp", [{ ...effort, id: "thought" }]);

    expect(loadCachedAcpConfigOptions("claude-acp")).toEqual([effort]);
    expect(loadCachedAcpConfigOptions("codex-acp")).toEqual([{ ...effort, id: "thought" }]);
    expect(loadCachedAcpConfigOptions("opencode")).toBeNull();
  });

  it("a later advertisement replaces the earlier one", () => {
    saveCachedAcpConfigOptions("claude-acp", [effort]);
    saveCachedAcpConfigOptions("claude-acp", [{ ...effort, currentValue: "high" }]);
    expect(loadCachedAcpConfigOptions("claude-acp")).toEqual([{ ...effort, currentValue: "high" }]);
  });
});

describe("an empty list is a verdict, not a miss", () => {
  // v1 conflated the two, so "this agent has no knobs" could only be learned
  // from a live session — which is a 3-4 second spinner on every cold start for
  // an answer that never changes. The pill needs to tell them apart:
  //   [] → render "Default" immediately
  //   null → nothing is known, and only THAT justifies a loader.
  it("remembers that an agent advertised no knobs", () => {
    saveCachedAcpConfigOptions("claude-acp", []);
    expect(loadCachedAcpConfigOptions("claude-acp")).toEqual([]);
  });

  it("still distinguishes an unheard-of agent", () => {
    expect(loadCachedAcpConfigOptions("never-seen")).toBeNull();
  });

  // Not clobbering a live list with an empty one is the STORE's guard
  // (`setAcpConfigOptions` caches what landed, not what was passed), so this
  // layer writes exactly what it is told — see chat-store.config-options.test.
  it("writes what it is given, in order", () => {
    saveCachedAcpConfigOptions("claude-acp", [effort]);
    saveCachedAcpConfigOptions("claude-acp", []);
    expect(loadCachedAcpConfigOptions("claude-acp")).toEqual([]);
  });
});

describe("the v1 → v2 upgrade hop", () => {
  it("reads a v1 payload when there is no v2 one yet", () => {
    // #162 shipped v1 a day before v2; a user upgrading mid-week must not get a
    // spinner back for every agent they have already used.
    localStorage.setItem("atlas:acp-config-options:v1:claude-acp", JSON.stringify([effort]));
    expect(loadCachedAcpConfigOptions("claude-acp")).toEqual([effort]);
  });

  it("prefers v2 once it exists", () => {
    localStorage.setItem("atlas:acp-config-options:v1:claude-acp", JSON.stringify([effort]));
    saveCachedAcpConfigOptions("claude-acp", []);
    expect(loadCachedAcpConfigOptions("claude-acp")).toEqual([]);
  });
});

describe("corrupt storage", () => {
  it("is a cache miss, not a throw", () => {
    localStorage.setItem("atlas:acp-config-options:claude-acp", "{not json");
    expect(loadCachedAcpConfigOptions("claude-acp")).toBeNull();
  });

  it("a non-array payload is a miss too", () => {
    localStorage.setItem("atlas:acp-config-options:claude-acp", JSON.stringify({ nope: 1 }));
    expect(loadCachedAcpConfigOptions("claude-acp")).toBeNull();
  });
});

describe("upstream-merged rules (0.3.0-x)", () => {
  it("an entry without an id makes the whole cache a miss — it could not be set on click", () => {
    localStorage.setItem(
      "atlas:acp-config-options:v1:claude-acp",
      JSON.stringify([{ name: "Nameless", type: "select", options: [{ value: "a", name: "A" }] }]),
    );
    expect(loadCachedAcpConfigOptions("claude-acp")).toBeNull();
  });

  it("the key is versioned — a pre-v1 payload is simply not read", () => {
    localStorage.setItem("atlas:acp-config-options:claude-acp", JSON.stringify([effort]));
    expect(loadCachedAcpConfigOptions("claude-acp")).toBeNull();
  });
});
