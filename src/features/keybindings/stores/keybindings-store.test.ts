import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeybindingsFile } from "../lib/types";
import { DEFAULT_KEYBINDINGS_FILE } from "../lib/types";

const api = vi.hoisted(() => ({
  exists: false,
  saved: [] as KeybindingsFile[],
}));

vi.mock("../lib/keybindings-api", () => ({
  loadKeybindings: async () => ({
    file: DEFAULT_KEYBINDINGS_FILE,
    path: "/tmp/keybindings.json",
    exists: api.exists,
    warnings: [],
  }),
  saveKeybindings: async (file: KeybindingsFile) => {
    api.saved.push(file);
    return file;
  },
}));

const { useKeybindingsStore } = await import("./keybindings-store");
const actions = () => useKeybindingsStore.getState().actions;
const active = () => {
  const { file } = useKeybindingsStore.getState();
  return file.profiles.find((p) => p.id === file.activeProfileId)!;
};

beforeEach(() => {
  api.exists = false;
  api.saved = [];
  useKeybindingsStore.setState({ file: DEFAULT_KEYBINDINGS_FILE, firstRun: false });
});

describe("first run", () => {
  it("is due only when load finds no file", async () => {
    await actions().load();
    expect(useKeybindingsStore.getState().firstRun).toBe(true);
    api.exists = true;
    await actions().load();
    expect(useKeybindingsStore.getState().firstRun).toBe(false);
  });

  it("'decide later' still writes the file, which is what records the answer", async () => {
    await actions().load();
    await actions().completeOnboarding(null);
    expect(useKeybindingsStore.getState().firstRun).toBe(false);
    expect(api.saved).toHaveLength(1);
    expect(api.saved[0]!.activeProfileId).toBe("default");
  });

  it("a preset answer creates and activates a profile based on it", async () => {
    await actions().load();
    await actions().completeOnboarding("zed");
    expect(active().basedOn).toBe("zed");
    expect(active().name).toBe("Zed");
    expect(api.saved[api.saved.length - 1]!.activeProfileId).toBe(active().id);
  });
});

describe("presets", () => {
  it("reuses an untouched profile on the same preset instead of stacking copies", () => {
    const first = actions().createProfileFromPreset("vscode");
    actions().setActiveProfile("default");
    expect(actions().createProfileFromPreset("vscode")).toBe(first);
    expect(useKeybindingsStore.getState().file.profiles).toHaveLength(2);
  });

  it("adding a chord starts from the preset's chords, not the registry's", () => {
    actions().createProfileFromPreset("vscode");
    actions().addBinding("nav.commandPalette", "cmd+k");
    expect(active().bindings["nav.commandPalette"]).toEqual(["cmd+shift+p", "f1", "cmd+k"]);
  });

  it("changing a profile's preset keeps its overrides", () => {
    actions().createProfileFromPreset("vscode");
    actions().setBinding("tabs.close", ["cmd+shift+w"]);
    actions().setProfilePreset(active().id, null);
    expect(active().basedOn).toBeUndefined();
    expect(active().bindings["tabs.close"]).toEqual(["cmd+shift+w"]);
  });
});

describe("import", () => {
  it("adds the pasted profile as a new active one, with a unique name", () => {
    actions().createProfileFromPreset("cursor");
    const text = JSON.stringify({ atlasKeybindings: 1, name: "Cursor", bindings: {} });
    const result = actions().importProfile(text);
    expect(result.ok).toBe(true);
    expect(active().name).toBe("Cursor 2");
    expect(useKeybindingsStore.getState().file.profiles).toHaveLength(3);
  });

  it("changes nothing when the paste is rejected", () => {
    const before = useKeybindingsStore.getState().file;
    expect(actions().importProfile("{").ok).toBe(false);
    expect(useKeybindingsStore.getState().file).toBe(before);
  });
});

describe("editing the built-in Default", () => {
  it("forks it into an active 'My keybindings' instead of refusing", () => {
    actions().setBinding("tabs.close", ["cmd+shift+w"]);
    expect(active().builtIn).toBeUndefined();
    expect(active().name).toBe("My keybindings");
    expect(active().bindings["tabs.close"]).toEqual(["cmd+shift+w"]);
    const builtIn = useKeybindingsStore.getState().file.profiles.find((p) => p.builtIn)!;
    expect(builtIn.bindings).toEqual({});
  });

  it("does not fork for an edit that changes nothing", () => {
    actions().resetBinding("tabs.close");
    expect(active().builtIn).toBe(true);
    expect(useKeybindingsStore.getState().file.profiles).toHaveLength(1);
  });

  it("forks when the keymap under Default changes", () => {
    actions().setProfilePreset("default", "zed");
    expect(active().builtIn).toBeUndefined();
    expect(active().basedOn).toBe("zed");
  });
});
