import { describe, expect, it } from "vitest";
import { exportProfile, importProfile } from "./profile-transfer";

describe("profile transfer", () => {
  it("round-trips a profile, sorted and without its id", () => {
    const text = exportProfile({
      id: "profile-x",
      name: "Mine",
      basedOn: "zed",
      bindings: { "tabs.close": ["cmd+w"], "panels.left": null },
    });
    expect(text).not.toContain("profile-x");
    expect(text.indexOf("panels.left")).toBeLessThan(text.indexOf("tabs.close"));
    const back = importProfile(text);
    expect(back).toEqual({
      ok: true,
      profile: {
        name: "Mine",
        basedOn: "zed",
        bindings: { "panels.left": null, "tabs.close": ["cmd+w"] },
      },
      unknownActionIds: [],
      unknownPresetId: null,
    });
  });

  it("carries conditions, and refuses one it can't read", () => {
    const text = exportProfile({
      id: "x",
      name: "Mine",
      bindings: {},
      when: { "nav.commandPalette": "!terminalFocus" },
    });
    const back = importProfile(text);
    expect(back.ok && back.profile.when).toEqual({ "nav.commandPalette": "!terminalFocus" });
    const bad = importProfile(
      JSON.stringify({
        atlasKeybindings: 1,
        name: "x",
        bindings: {},
        when: { "tabs.close": "a &&" },
      }),
    );
    expect(bad.ok).toBe(false);
  });

  it("keeps commands and presets this build doesn't know, and says so", () => {
    const r = importProfile(
      JSON.stringify({
        atlasKeybindings: 1,
        name: "From the future",
        basedOn: "helix",
        bindings: { "someday.command": ["cmd+y"] },
      }),
    );
    expect(r.ok && r.profile.bindings["someday.command"]).toEqual(["cmd+y"]);
    expect(r.ok && r.unknownActionIds).toEqual(["someday.command"]);
    expect(r.ok && r.unknownPresetId).toBe("helix");
  });

  it("rejects what it can't read", () => {
    expect(importProfile("not json").ok).toBe(false);
    expect(importProfile("[]").ok).toBe(false);
    expect(importProfile(JSON.stringify({ name: "x", bindings: {} })).ok).toBe(false);
    expect(importProfile(JSON.stringify({ atlasKeybindings: 2, bindings: {} })).ok).toBe(false);
    expect(
      importProfile(JSON.stringify({ atlasKeybindings: 1, bindings: { "tabs.close": "cmd+w" } }))
        .ok,
    ).toBe(false);
    expect(
      importProfile(
        JSON.stringify({ atlasKeybindings: 1, bindings: { "tabs.close": ["cmd+bogus"] } }),
      ).ok,
    ).toBe(false);
  });
});
