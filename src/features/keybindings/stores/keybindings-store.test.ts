import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The keymap half of the `config.toml` seam.
 *
 * These assert the wire contract, because it carries a distinction that is
 * invisible in the UI and impossible to recover from once it is wrong: `""`
 * unbinds a command, `null` deletes the override entirely, and an absent key
 * leaves it alone. Getting those confused turns "reset this shortcut" into
 * "make this command unreachable".
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { useKeybindingsStore } = await import("./keybindings-store");
const { serializeCombo } = await import("../lib/combo");

/** The reply Rust sends back: whatever the file now holds. */
function reply(keymap: { preset: string; bindings: Record<string, string> }) {
  return { kind: "applied", settings: {}, keymap, generation: 1 };
}

function patchOf(call: number): { preset?: string; bindings?: Record<string, string | null> } {
  return invoke.mock.calls[call][1].patch;
}

function chordOf(actionId: string): string | null {
  const [first] =
    useKeybindingsStore.getState().keymap.bindings.find((b) => b.action.id === actionId)?.combos ??
    [];
  return first ? serializeCombo(first) : null;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(reply({ preset: "atlas", bindings: {} }));
  useKeybindingsStore.getState().actions.hydrate({ preset: "atlas", bindings: {} });
});

describe("hydrate", () => {
  it("reads an empty-string binding as unbound, not as a chord", () => {
    useKeybindingsStore.getState().actions.hydrate({
      preset: "atlas",
      bindings: { "close-tab": "" },
    });
    expect(chordOf("close-tab")).toBeNull();
  });

  it("falls back to the Atlas preset when the file names one this build lacks", () => {
    useKeybindingsStore.getState().actions.hydrate({ preset: "sublime", bindings: {} });
    expect(useKeybindingsStore.getState().preset).toBe("atlas");
  });
});

describe("setBinding", () => {
  it("sends the chord and applies it immediately", async () => {
    await useKeybindingsStore.getState().actions.setBinding("close-tab", "mod+shift+w");
    expect(invoke).toHaveBeenCalledWith(
      "update_atlas_keymap",
      expect.objectContaining({ expectedGeneration: expect.any(Number) }),
    );
    expect(patchOf(0).bindings).toEqual({ "close-tab": "mod+shift+w" });
  });

  it("sends an empty string to unbind", async () => {
    await useKeybindingsStore.getState().actions.setBinding("close-tab", null);
    expect(patchOf(0).bindings).toEqual({ "close-tab": "" });
  });
});

describe("resetBinding", () => {
  it("sends null, which deletes the line rather than unbinding the command", async () => {
    await useKeybindingsStore.getState().actions.resetBinding("close-tab");
    expect(patchOf(0).bindings).toEqual({ "close-tab": null });
  });
});

describe("setBindings", () => {
  it("moves a chord between commands in a single write", async () => {
    await useKeybindingsStore
      .getState()
      .actions.setBindings({ "command-palette": null, "close-tab": "mod+k" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(patchOf(0).bindings).toEqual({ "command-palette": "", "close-tab": "mod+k" });
  });
});

describe("resetAllBindings", () => {
  it("deletes every override it currently has, and nothing else", async () => {
    useKeybindingsStore.getState().actions.hydrate({
      preset: "vscode",
      bindings: { "close-tab": "mod+shift+w", "new-chat": "" },
    });

    await useKeybindingsStore.getState().actions.resetAllBindings();

    expect(patchOf(0).bindings).toEqual({ "close-tab": null, "new-chat": null });
    expect(patchOf(0).preset).toBeUndefined();
  });
});

describe("replaceKeymap", () => {
  it("clears the overrides it is replacing in the same patch that writes the new ones", async () => {
    useKeybindingsStore.getState().actions.hydrate({
      preset: "atlas",
      bindings: { "close-tab": "mod+shift+w" },
    });

    await useKeybindingsStore.getState().actions.replaceKeymap("zed", { "new-chat": "mod+l" });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(patchOf(0)).toEqual({
      preset: "zed",
      bindings: { "close-tab": null, "new-chat": "mod+l" },
    });
  });
});

describe("the reply", () => {
  it("adopts what the file ended up holding, not what was sent", async () => {
    invoke.mockResolvedValue(reply({ preset: "zed", bindings: { "close-tab": "mod+alt+w" } }));

    await useKeybindingsStore.getState().actions.setBinding("close-tab", "mod+shift+w");

    expect(useKeybindingsStore.getState().preset).toBe("zed");
    expect(chordOf("close-tab")).toBe("mod+alt+w");
  });

  it("throws on a conflict Rust would not resolve, so Settings can say so", async () => {
    invoke.mockResolvedValue({
      kind: "conflict",
      settings: {},
      keymap: { preset: "atlas", bindings: {} },
      generation: 9,
    });

    await expect(
      useKeybindingsStore.getState().actions.setBinding("close-tab", "mod+shift+w"),
    ).rejects.toThrow(/conflict/i);
  });
});
