// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_THEMES } from "@/dev/mock-backend/fixtures/builtin-themes";
import { applyTheme, appearanceForMode, resolvedThemeCss } from "./apply-theme";

/** Pretend the OS is asking for a light appearance. */
function osPrefersLight(light: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: light && query.includes("light"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The light appearance shipped behind `LIGHT_APPEARANCE_ENABLED` while the
 * app-wide light pass was unfinished, and hiding the Light button was only
 * half of it: `system` asks the OS, and a light Mac answers "light", so a user
 * who never chose light was booted into the unfinished UI with no visible
 * control to leave it. The pass is done and the flag is gone; what these pin
 * is that `system` and the explicit modes agree with the picker again.
 */
describe("appearanceForMode", () => {
  it("always honours an explicit dark", () => {
    osPrefersLight(true);
    expect(appearanceForMode("dark")).toBe("dark");
  });

  it("always honours an explicit light", () => {
    osPrefersLight(false);
    expect(appearanceForMode("light")).toBe("light");
  });

  it("follows the OS under `system`", () => {
    osPrefersLight(true);
    expect(appearanceForMode("system")).toBe("light");

    osPrefersLight(false);
    expect(appearanceForMode("system")).toBe("dark");
  });

  it("falls back to dark where there is no `matchMedia` to ask", () => {
    // A non-DOM context — a test, or a module evaluated before the webview.
    vi.stubGlobal("matchMedia", undefined);
    expect(appearanceForMode("system")).toBe("dark");
  });
});

/**
 * `index.html` sets seven `--atlas-boot-*` INLINE properties on `<html>` from
 * the cached launch colours, and binds the root `background` and `color-scheme`
 * to them. An inline property beats the `:root{…}` block `applyTheme` writes
 * into `<head>`, so an `applyTheme` that did not refresh them left the page on
 * the PREVIOUS theme's `color-scheme` and root background for the whole
 * session — native scrollbars, form controls and the caret following an
 * appearance the user had already switched away from.
 */
describe("applyTheme and the boot variables", () => {
  const themes = BUILTIN_THEMES;
  const rosePine = themes.find((t) => t.id === "rose-pine")!;
  const boot = () => document.documentElement.style;

  it("refreshes them on every apply, appearance included", () => {
    const dark = applyTheme(rosePine, "dark");
    expect(boot().getPropertyValue("--atlas-boot-scheme")).toBe("dark");
    expect(boot().getPropertyValue("--atlas-boot-bg")).toBe(dark.base.background);
    expect(boot().getPropertyValue("--atlas-boot-card")).toBe(dark.base.card);

    const light = applyTheme(rosePine, "light");
    expect(light.appearance).toBe("light");
    expect(boot().getPropertyValue("--atlas-boot-scheme")).toBe("light");
    expect(boot().getPropertyValue("--atlas-boot-bg")).toBe(light.base.background);
    // The point of the bug: the dark value must be GONE, not merely shadowed.
    expect(boot().getPropertyValue("--atlas-boot-bg")).not.toBe(dark.base.background);
  });

  it("writes the same seven values it caches for the next cold start", () => {
    const resolved = applyTheme(rosePine, "light");
    const cached = JSON.parse(localStorage.getItem("atlas:launch-theme")!);

    expect(cached.appearance).toBe(resolved.appearance);
    expect(boot().getPropertyValue("--atlas-boot-scheme")).toBe(cached.appearance);
    expect(boot().getPropertyValue("--atlas-boot-bg")).toBe(cached.background);
    expect(boot().getPropertyValue("--atlas-boot-chrome")).toBe(cached.chrome);
    expect(boot().getPropertyValue("--atlas-boot-card")).toBe(cached.card);
    expect(boot().getPropertyValue("--atlas-boot-line")).toBe(cached.line);
    expect(boot().getPropertyValue("--atlas-boot-skeleton")).toBe(cached.skeleton);
    expect(boot().getPropertyValue("--atlas-boot-text")).toBe(cached.text);
  });
});

/**
 * The cold-start replay. The app's first render lands three IPC round trips
 * before the first `applyTheme`, and it used to find no theme-key variable at
 * all — transparent surfaces, and a dark flash for anyone on a light theme.
 * `index.html` now replays the whole cached map into the same `<style>`; these
 * run that inline script for real, against what `applyTheme` cached.
 */
describe("the launch replay in index.html", () => {
  const themes = BUILTIN_THEMES;
  const rosePine = themes.find((t) => t.id === "rose-pine")!;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const html = readFileSync(path.join(repoRoot, "index.html"), "utf8");
  const bootScript = html.match(
    /<script>\s*(\(function \(\) \{[\s\S]*?atlas:launch-theme[\s\S]*?)<\/script>/,
  )![1];

  /** A cold start: nothing the previous page wrote is left but localStorage. */
  function coldStart(): void {
    document.getElementById("atlas-resolved-theme")?.remove();
    document.documentElement.removeAttribute("style");
    document.documentElement.className = "";
    new Function(bootScript)();
  }

  it("caches the whole resolved map, not just the skeleton colours", () => {
    const resolved = applyTheme(rosePine, "light");
    const cached = JSON.parse(localStorage.getItem("atlas:launch-theme")!);
    expect(cached.vars).toEqual(resolved.cssVars);
    expect(cached.id).toBe("rose-pine");
  });

  it("writes exactly the block applyTheme would, before any module runs", () => {
    const resolved = applyTheme(rosePine, "light");
    coldStart();

    const style = document.getElementById("atlas-resolved-theme");
    expect(style?.textContent).toBe(resolvedThemeCss(resolved.cssVars));
    expect(style?.textContent).toContain("--element-hover:");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.themeAppearance).toBe("light");
  });

  it("drops no value from any built-in theme", () => {
    // The replay skips a value it cannot write safely; no real theme may have one.
    for (const theme of themes) {
      for (const mode of ["dark", "light"] as const) {
        const resolved = applyTheme(theme, mode);
        coldStart();
        expect(document.getElementById("atlas-resolved-theme")?.textContent, theme.id).toBe(
          resolvedThemeCss(resolved.cssVars),
        );
      }
    }
  });

  it("is the element applyTheme then rewrites, not a second one", () => {
    applyTheme(rosePine, "light");
    coldStart();
    const dark = applyTheme(rosePine, "dark");

    const blocks = document.querySelectorAll("#atlas-resolved-theme");
    expect(blocks).toHaveLength(1);
    // The page's own block first, then the inverted scope — one element
    // carrying both, so a surface asking for the other appearance cannot be
    // served by a stylesheet the last `applyTheme` left behind.
    expect(blocks[0].textContent).toContain(resolvedThemeCss(dark.cssVars));
    expect(blocks[0].textContent?.startsWith(resolvedThemeCss(dark.cssVars))).toBe(true);
  });

  it("carries the other appearance under `[data-theme-invert]`", () => {
    // A panel over the record reads as a layer rather than as more of the
    // page when it is the opposite colour — the reader's share sheet and its
    // comments both ask for it.
    const dark = applyTheme(rosePine, "dark");
    const css = document.getElementById("atlas-resolved-theme")?.textContent ?? "";
    const inverted = css.slice(css.indexOf("[data-theme-invert]"));

    expect(inverted).toContain("[data-theme-invert]{");
    // The light variant's background, not the dark page's.
    expect(inverted).toContain(`--background:${rosePine.light?.base.background}`);
    expect(dark.cssVars["--background"]).not.toBe(rosePine.light?.base.background);
    // Every variable is re-declared, not only the ones that differ: a
    // half-declared scope inherits the page's already-resolved answers.
    for (const name of Object.keys(dark.cssVars)) expect(inverted).toContain(`${name}:`);
  });

  it("skips an entry that could close the block", () => {
    localStorage.setItem(
      "atlas:launch-theme",
      JSON.stringify({
        appearance: "dark",
        vars: { "--background": "navy", "--x": "red}body{display:none", "bad name": "red" },
      }),
    );
    coldStart();
    expect(document.getElementById("atlas-resolved-theme")?.textContent).toBe(
      "html:root{--background:navy}",
    );
  });

  it("does nothing on a first run", () => {
    localStorage.removeItem("atlas:launch-theme");
    coldStart();
    expect(document.getElementById("atlas-resolved-theme")).toBeNull();
  });
});
