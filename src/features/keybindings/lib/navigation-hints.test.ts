import { describe, expect, it } from "vitest";
import {
  ariaShortcut,
  bindingForTarget,
  navigationBindings,
  splitNavigationActions,
  tabNavigationActions,
} from "./navigation-hints";
import { parseCombo } from "./combo";
import { resolveProfile } from "./resolve";
import type { KeybindingProfile } from "./types";

const profile = (bindings: KeybindingProfile["bindings"] = {}, basedOn?: string) =>
  resolveProfile({ id: "custom", name: "Custom", bindings, basedOn });
const command = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
const control = { ...command, metaKey: false, ctrlKey: true };

describe("navigation destinations", () => {
  it("keeps 9 on the last tab when there are more than nine tabs", () => {
    expect(tabNavigationActions(7, 12, 0)).toContain("tabs.focus8");
    expect(tabNavigationActions(8, 12, 0)).toEqual([]);
    expect(tabNavigationActions(11, 12, 0)).toContain("tabs.focus9");
    expect(tabNavigationActions(2, 3, 0)).toContain("tabs.focus9");
    expect(tabNavigationActions(-1, 3, 0)).toEqual([]);
    expect(tabNavigationActions(3, 3, 0)).toEqual([]);
  });

  it("maps previous/next to their wrapped destinations, including a stale active id", () => {
    expect(tabNavigationActions(3, 4, 0)).toContain("tabs.prev");
    expect(tabNavigationActions(0, 4, 3)).toContain("tabs.next");
    expect(tabNavigationActions(1, 4, -1)).toContain("tabs.next");
    expect(tabNavigationActions(0, 1, 0)).not.toContain("tabs.next");
  });

  it("only offers adjacent panes and never wraps at the edges", () => {
    const groups = ["main", "middle", "right"];
    expect(splitNavigationActions("main", groups, "middle")).toEqual(["split.focusLeft"]);
    expect(splitNavigationActions("right", groups, "middle")).toEqual(["split.focusRight"]);
    expect(splitNavigationActions("right", groups, "main")).toEqual([]);
    expect(splitNavigationActions("main", groups, "main")).toEqual([]);
    expect(splitNavigationActions("missing", groups, "main")).toEqual([]);
  });

  it("prefers the tab index, but uses a rebound last-tab key if that index is unbound", () => {
    const actions = tabNavigationActions(2, 3, 0);
    expect(
      bindingForTarget(actions, navigationBindings(profile(), true), command, true)?.serialized,
    ).toBe("cmd+3");
    const bindings = navigationBindings(
      profile({ "tabs.focus3": null, "tabs.focus9": ["cmd+l"] }),
      true,
    );
    expect(bindingForTarget(actions, bindings, command, true)?.serialized).toBe("cmd+l");
  });

  it("only draws a follow-up key when every required modifier is already held", () => {
    const bindings = navigationBindings(profile(), true);
    expect(bindingForTarget(["panels.right"], bindings, command, true)).toBeUndefined();
    expect(
      bindingForTarget(["panels.right"], bindings, { ...command, shiftKey: true }, true)
        ?.serialized,
    ).toBe("cmd+shift+b");
    expect(
      bindingForTarget(["panels.left"], bindings, { ...command, altKey: true }, true),
    ).toBeUndefined();
  });

  it("uses preset Control bindings on macOS and folds both spellings off macOS", () => {
    const bindings = navigationBindings(profile({}, "vscode"), true);
    expect(bindingForTarget(["tabs.focus1"], bindings, command, true)).toBeUndefined();
    expect(bindingForTarget(["tabs.focus1"], bindings, control, true)?.serialized).toBe("ctrl+1");
    expect(
      bindingForTarget(["tabs.focus1"], navigationBindings(profile(), false), control, false)
        ?.serialized,
    ).toBe("cmd+1");
  });
});

describe("navigation dispatch ownership", () => {
  it("hides a chord won by another registered global action, after platform folding", () => {
    const resolved = profile({ "nav.commandPalette": ["cmd+2"], "tabs.focus2": ["ctrl+2"] });
    const registered = new Set<"nav.commandPalette" | "tabs.focus2">([
      "nav.commandPalette",
      "tabs.focus2",
    ]);
    expect(
      navigationBindings(resolved, false, registered).some((b) => b.actionId === "tabs.focus2"),
    ).toBe(false);
    expect(
      navigationBindings(resolved, true, registered).some((b) => b.actionId === "tabs.focus2"),
    ).toBe(true);
    expect(
      navigationBindings(resolved, false, new Set(["tabs.focus2"])).map((b) => b.actionId),
    ).toEqual(["tabs.focus2"]);
  });

  it("omits OS reservations and unregistered destinations", () => {
    const bindings = navigationBindings(
      profile({ "tabs.focus1": ["cmd+tab"] }),
      true,
      new Set(["tabs.focus1"]),
    );
    expect(bindings).toEqual([]);
    expect(navigationBindings(profile(), false, new Set())).toEqual([]);
  });

  it("lets active scopes and the separate hint-navigation trigger claim their chords", () => {
    const resolved = profile({ "terminal.nextTab": ["cmd+2"], "hintNav.toggle": ["cmd+3"] });
    const ids = navigationBindings(resolved, true, undefined, new Set(["terminal.nextTab"])).map(
      (b) => b.actionId,
    );
    expect(ids).not.toContain("tabs.focus2");
    expect(ids).not.toContain("tabs.focus3");
    expect(ids).toContain("tabs.focus1");
  });

  it.each([
    ["cmd+1", true, "Meta+1"],
    ["ctrl+1", true, "Control+1"],
    ["cmd+shift+b", true, "Shift+Meta+B"],
    ["cmd+shift+b", false, "Control+Shift+B"],
    ["cmd+ctrl+x", false, "Control+Meta+X"],
    ["cmd+alt+left", true, "Alt+Meta+ArrowLeft"],
  ] as const)("exposes %s as an ARIA shortcut (mac=%s)", (combo, mac, expected) => {
    expect(ariaShortcut(parseCombo(combo)!, mac)).toBe(expected);
  });
});
