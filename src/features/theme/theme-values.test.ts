// @vitest-environment happy-dom
//
// The chain every palette-caching subsystem hangs off: `applyTheme` dispatches
// `atlas:theme-applied`, `theme-values` turns that into a version bump, and
// each consumer either re-runs an imperative callback or re-renders.
//
// `tests/theme-subscription-contract.test.ts` checks that every consumer is
// WIRED to this. These check the wire itself carries a signal, and that the
// values on the other side of it actually change — a version that increments
// while `themeColor()` keeps answering the old palette would pass a structural
// check and still ship the bug.

import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "@/dev/mock-backend/fixtures/builtin-themes";
import { applyTheme } from "./apply-theme";
import { act, renderHook } from "@testing-library/react";
import { useSeriesPalette } from "@/features/usage/lib/palette";
import { terminalTheme } from "@/features/terminal/lib/terminal-theme";
import { graphPalette } from "@/components/graph-palette";
import { onThemeApplied, themeBase, themeColor } from "./theme-values";

const themes = BUILTIN_THEMES;
const rosePine = themes.find((theme) => theme.id === "rose-pine")!;
const atlas = themes.find((theme) => theme.id === "atlas")!;

beforeEach(() => {
  applyTheme(atlas, "dark");
});

describe("the theme-applied signal", () => {
  it("reaches an imperative subscriber, and stops when it unsubscribes", () => {
    let seen = 0;
    const off = onThemeApplied(() => {
      seen += 1;
    });

    applyTheme(rosePine, "light");
    expect(seen).toBe(1);
    applyTheme(atlas, "dark");
    expect(seen).toBe(2);

    off();
    applyTheme(rosePine, "light");
    expect(seen).toBe(2);
  });

  it("changes what the value readers answer", () => {
    const darkFg = themeBase("foreground");
    const darkKeyword = themeColor("syntax.keyword");

    applyTheme(rosePine, "light");

    expect(themeBase("foreground")).not.toBe(darkFg);
    expect(themeColor("syntax.keyword")).not.toBe(darkKeyword);
  });
});

/**
 * One assertion per subsystem that snapshots a palette, against the builder it
 * snapshots THROUGH. Together with the subscription contract — "this builder's
 * owner listens" — that is the whole of "it repaints on a switch", minus the
 * pixels, which the browser pass covers.
 */
describe("the palettes a subsystem snapshots", () => {
  it("rebuilds xterm's ITheme", () => {
    const dark = terminalTheme();
    applyTheme(rosePine, "light");
    const light = terminalTheme();

    expect(light.background).not.toBe(dark.background);
    expect(light.foreground).not.toBe(dark.foreground);
    expect(light.red).not.toBe(dark.red);
    // The 19 keys are the point — a partial refresh is the subtler bug.
    expect(Object.keys(light)).toEqual(Object.keys(dark));
  });

  it("rebuilds the pixi graph palette", () => {
    const dark = graphPalette();
    applyTheme(rosePine, "light");
    const light = graphPalette();

    expect(light).not.toEqual(dark);
  });

  it("rebuilds the chart series palette, through the hook a chart actually uses", () => {
    const { result, unmount } = renderHook(() => useSeriesPalette());
    const dark = { first: result.current.seriesColor(0), other: result.current.otherColor };

    // The hook's only dependency is `useThemeVersion()`, so this is also the
    // assertion that the version bump reaches a mounted React consumer.
    act(() => {
      applyTheme(rosePine, "light");
    });

    expect(result.current.seriesColor(0)).not.toBe(dark.first);
    expect(result.current.otherColor).not.toBe(dark.other);
    unmount();
  });
});
