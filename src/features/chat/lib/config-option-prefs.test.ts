// @vitest-environment happy-dom
//
// Per-agent config-option preferences (#33). Zed re-applies persisted defaults
// at session open; Atlas keeps per-agent prefs on the frontend (the same home
// as the mode pref) and pushes them after bind — validated against what the
// agent actually advertises, never as a blind override.

import { beforeEach, describe, expect, it } from "vitest";
import {
  configOptionPushes,
  loadConfigOptionPrefs,
  saveConfigOptionPref,
} from "./config-option-prefs";

beforeEach(() => localStorage.clear());

describe("persistence", () => {
  it("remembers a pick per agent", () => {
    saveConfigOptionPref("codex", "thought", "high");
    saveConfigOptionPref("codex", "web-search", true);
    saveConfigOptionPref("opencode", "thought", "low");

    expect(loadConfigOptionPrefs("codex")).toEqual({ thought: "high", "web-search": true });
    expect(loadConfigOptionPrefs("opencode")).toEqual({ thought: "low" });
    expect(loadConfigOptionPrefs("cursor")).toEqual({});
  });

  it("overwrites an earlier pick for the same knob", () => {
    saveConfigOptionPref("codex", "thought", "high");
    saveConfigOptionPref("codex", "thought", "low");
    expect(loadConfigOptionPrefs("codex")).toEqual({ thought: "low" });
  });
});

describe("configOptionPushes", () => {
  const advertised = [
    {
      id: "thought",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
      ],
    },
    { id: "web-search", name: "Web search", type: "boolean", currentValue: false },
  ];

  /// The whole feature: a remembered pick for an advertised knob whose current
  /// value differs gets pushed once at open.
  it("pushes remembered picks the agent advertises and is not already on", () => {
    expect(configOptionPushes(advertised, { thought: "high", "web-search": true })).toEqual([
      { configId: "thought", value: "high" },
      { configId: "web-search", value: true },
    ]);
  });

  /// Never an Atlas-side override the agent did not offer: an id the agent no
  /// longer advertises, or a select value outside its choices, is dropped —
  /// same discipline as the mode pref's revalidation.
  it("drops picks the agent does not advertise or offer", () => {
    expect(
      configOptionPushes(advertised, {
        gone: "x",
        thought: "ultra", // not among the choices
      }),
    ).toEqual([]);
  });

  /// A pick the agent already sits on is not re-pushed — pushing it would be a
  /// wasted round trip per session open.
  it("skips picks that match the agent's current value", () => {
    expect(configOptionPushes(advertised, { thought: "medium", "web-search": false })).toEqual([]);
  });

  /// A boolean pref for a select (or vice versa) is a stale shape, not a push.
  it("drops picks whose type no longer matches the knob", () => {
    expect(configOptionPushes(advertised, { thought: true, "web-search": "yes" })).toEqual([]);
  });

  it("has nothing to push when nothing is remembered", () => {
    expect(configOptionPushes(advertised, {})).toEqual([]);
    expect(configOptionPushes([], { thought: "high" })).toEqual([]);
  });
});
