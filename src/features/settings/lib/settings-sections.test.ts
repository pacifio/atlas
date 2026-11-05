import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_REGISTRY } from "./app-settings";
import { changedOnPage, isDefaultValue, searchItems, searchSettings } from "./settings-sections";

describe("settings search", () => {
  it("finds a row by its exact title first", () => {
    expect(searchSettings("Inline Git blame")[0]?.id).toBe("gitBlameInline");
  });

  it("finds a row by a word that is only in its summary or key", () => {
    const ids = searchSettings("dotfiles").map((item) => item.id);
    expect(ids).toContain("showHiddenFiles");
    expect(searchSettings("uiScale")[0]?.id).toBe("uiScale");
  });

  it("finds screens that have no config key", () => {
    expect(searchSettings("shortcuts").map((item) => item.section)).toContain("keybindings");
  });

  it("never offers internal keys", () => {
    const ids = new Set(searchItems().map((item) => item.id));
    for (const meta of SETTINGS_REGISTRY) {
      if (meta.status === "internal") {
        expect(ids.has(meta.key), meta.key).toBe(false);
      }
    }
  });

  it("returns nothing for an empty query", () => {
    expect(searchSettings("  ")).toEqual([]);
  });
});

describe("restore defaults", () => {
  it("lists only live settings on the page that differ from their default", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      gitAutoFetch: false,
      enterToSend: false,
      // Internal bookkeeping on Updates must never be offered for reset.
      updaterIgnoredVersion: "9.9.9",
    };
    expect(changedOnPage("source-control", settings).map((meta) => meta.key)).toEqual([
      "gitAutoFetch",
    ]);
    expect(changedOnPage("updates", settings)).toEqual([]);
  });

  it("compares lists by value", () => {
    expect(isDefaultValue("notifyDisabledKinds", [])).toBe(true);
    expect(isDefaultValue("notifyDisabledKinds", ["git-behind"])).toBe(false);
  });
});
