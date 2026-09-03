import { describe, expect, it } from "vitest";
import { exportKeymap, importKeymap, KEYMAP_FILE_VERSION } from "./keymap-file";

describe("exportKeymap", () => {
  it("round-trips through importKeymap", () => {
    const overrides = { "close-tab": "mod+shift+w", "toggle-terminal": null };
    const result = importKeymap(exportKeymap("zed", overrides));
    expect(result).toEqual({ ok: true, preset: "zed", overrides, skipped: [] });
  });

  it("sorts bindings so the same keymap always exports byte-identically", () => {
    const a = exportKeymap("atlas", { "new-chat": "mod+t", "close-tab": "mod+w" });
    const b = exportKeymap("atlas", { "close-tab": "mod+w", "new-chat": "mod+t" });
    expect(a).toBe(b);
  });
});

describe("importKeymap", () => {
  function file(fields: Record<string, unknown>): string {
    return JSON.stringify({ atlasKeymap: KEYMAP_FILE_VERSION, preset: "atlas", ...fields });
  }

  it("skips commands this build doesn't have, keeping the rest", () => {
    const result = importKeymap(
      file({ bindings: { "close-tab": "mod+w", "warp-drive": "mod+9" } }),
    );
    expect(result).toEqual({
      ok: true,
      preset: "atlas",
      overrides: { "close-tab": "mod+w" },
      skipped: ["warp-drive"],
    });
  });

  it("rejects a keymap written by a newer Atlas", () => {
    const result = importKeymap(file({ atlasKeymap: KEYMAP_FILE_VERSION + 1 }));
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects JSON that isn't a keymap at all", () => {
    expect(importKeymap("{}")).toMatchObject({ ok: false });
    expect(importKeymap("[]")).toMatchObject({ ok: false });
    expect(importKeymap("not json")).toMatchObject({ ok: false });
  });

  it("rejects an unknown preset rather than silently using Atlas defaults", () => {
    expect(importKeymap(file({ preset: "sublime" }))).toMatchObject({ ok: false });
  });

  it("rejects a chord it cannot read", () => {
    expect(importKeymap(file({ bindings: { "close-tab": "mod+nope" } }))).toMatchObject({
      ok: false,
    });
  });

  it("rejects a binding that isn't a string or null", () => {
    expect(importKeymap(file({ bindings: { "close-tab": 42 } }))).toMatchObject({ ok: false });
  });
});
