import { describe, expect, it } from "vitest";
import { ORG_SCOPED_TYPES, PROJECTLESS_TYPES, type TabType } from "@/lib/constants";

/**
 * Org-scoped tabs must never reach the per-project editor state.
 *
 * That file is keyed by PROJECT PATH, and the same project is commonly open
 * in more than one org. A persisted `spaces-{convId}` tab therefore came back
 * on the INCOMING org's mount still pointing at the outgoing org's
 * conversation, rendering "This Space is no longer available" — closing the
 * tab on switch could not fix it, because the restore happened afterwards.
 */

/** The persist filter as `saveEditorState`/`flushEditorState` apply it. */
function persistable(tabs: Array<{ type: TabType; closable: boolean }>) {
  return tabs.filter((t) => t.closable && !ORG_SCOPED_TYPES.has(t.type));
}

/** The load-side guard, for files written before the fix. */
function restorable(tabs: Array<{ type: TabType }>) {
  return tabs.filter((t) => !ORG_SCOPED_TYPES.has(t.type));
}

describe("org-scoped tab persistence", () => {
  const tabs: Array<{ type: TabType; closable: boolean }> = [
    { type: "editor", closable: true },
    { type: "spaces", closable: true },
    { type: "comms-draft", closable: true },
    { type: "settings", closable: true },
    { type: "chat", closable: false },
  ];

  it("never writes spaces or draft tabs to the project's editor state", () => {
    const kept = persistable(tabs).map((t) => t.type);
    expect(kept).not.toContain("spaces");
    expect(kept).not.toContain("comms-draft");
    // Everything else that was persisted before still is.
    expect(kept).toEqual(["editor", "settings"]);
  });

  it("refuses to restore them from a file written before the fix", () => {
    const restored = restorable([
      { type: "editor" },
      { type: "spaces" },
      { type: "comms-draft" },
    ]).map((t) => t.type);
    expect(restored).toEqual(["editor"]);
  });

  it("settings is projectless but NOT org-scoped — it survives a switch", () => {
    expect(PROJECTLESS_TYPES.has("settings")).toBe(true);
    expect(ORG_SCOPED_TYPES.has("settings")).toBe(false);
  });

  it("every org-scoped type is also projectless (they open with no project)", () => {
    for (const type of ORG_SCOPED_TYPES) {
      expect(PROJECTLESS_TYPES.has(type)).toBe(true);
    }
  });
});
