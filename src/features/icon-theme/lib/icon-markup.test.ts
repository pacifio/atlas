// @vitest-environment happy-dom
//
// The icon theme drawn into HTML React did not render: a slot paints at once
// when its path is resolved, waits on its fallback when not, fills in when the
// store answers, and repaints when the theme changes.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./icon-theme-api", () => ({
  MINIMAL_ICON_THEME_ID: "minimal",
  resolveIcons: vi.fn(() => new Promise(() => {})),
  getIconThemeAssets: vi.fn(),
  getIconThemeFonts: vi.fn(),
  listIconThemes: async () => [],
  onIconThemesChanged: () => Promise.resolve(() => {}),
}));
vi.mock("./icon-preview", () => ({ clearIconThemePreviews: () => {} }));

const { useIconThemeStore, cacheKey } = await import("../stores/icon-theme-store");
const { fileIconMarkup, paintFileIcons, resetIconMarkupForTests, waitingSlotCountForTests } =
  await import("./icon-markup");

const FALLBACK = '<svg data-fallback=""></svg>';
const TS_SVG = '<svg fill="currentColor" data-ts=""></svg>';
const KEY = cacheKey({ path: "/p/a.ts", kind: "file", languageId: "typescript" });

function slot(path = "/p/a.ts"): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<span data-file-icon="file" data-file-path="${path}">${FALLBACK}</span>`;
  document.body.replaceChildren(root);
  return root;
}

function resolve(svg = TS_SVG) {
  useIconThemeStore.setState((s) => ({
    resolved: { ...s.resolved, [KEY]: { kind: "image", definition: "ts" } },
    prepared: { ...s.prepared, ts: { svg, url: null } },
  }));
}

beforeEach(() => {
  resetIconMarkupForTests();
  useIconThemeStore.setState({
    themeId: "material",
    generation: 1,
    resolved: {},
    prepared: {},
    missing: {},
  });
});

describe("file icons outside React", () => {
  it("draws nothing for the minimal theme", () => {
    useIconThemeStore.setState({ themeId: "minimal" });
    expect(fileIconMarkup("/p/a.ts")).toBeNull();
  });

  it("returns the theme's SVG for a resolved path, and caches the string", () => {
    resolve();
    expect(fileIconMarkup("/p/a.ts")).toBe(TS_SVG);
    // A cached string survives the record changing under the same theme.
    useIconThemeStore.setState({ prepared: {} });
    expect(fileIconMarkup("/p/a.ts")).toBe(TS_SVG);
  });

  it("paints a resolved slot at once", () => {
    resolve();
    const root = slot();
    paintFileIcons(root);
    expect(root.querySelector("[data-file-icon]")!.innerHTML).toBe(TS_SVG);
  });

  it("keeps the fallback while unresolved, then fills in when the store answers", () => {
    const root = slot();
    paintFileIcons(root);
    const el = root.querySelector<HTMLElement>("[data-file-icon]")!;
    expect(el.innerHTML).toBe(FALLBACK);
    resolve();
    expect(el.innerHTML).toBe(TS_SVG);
  });

  it("goes back to the fallback when the theme has nothing", () => {
    const root = slot();
    paintFileIcons(root);
    useIconThemeStore.setState((s) => ({ resolved: { ...s.resolved, [KEY]: null } }));
    expect(root.querySelector("[data-file-icon]")!.innerHTML).toBe(FALLBACK);
  });

  it("draws an SVG with its own colours as one image, and keeps a currentColor one inline", () => {
    resolve('<svg data-own-colours=""></svg>');
    const html = fileIconMarkup("/p/a.ts")!;
    expect(html.startsWith('<img src="data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(html).toContain(encodeURIComponent('<svg data-own-colours=""></svg>'));
  });

  it("paints into an empty slot, and empties it again when the theme has nothing", () => {
    const root = document.createElement("div");
    root.innerHTML = `<span data-file-icon="file" data-file-path="/p/a.ts"></span>`;
    document.body.replaceChildren(root);
    paintFileIcons(root);
    const el = root.querySelector<HTMLElement>("[data-file-icon]")!;
    resolve();
    expect(el.innerHTML).toBe(TS_SVG);
    useIconThemeStore.setState({ generation: 2, resolved: { [KEY]: null }, prepared: {} });
    expect(el.innerHTML).toBe("");
  });

  it("keeps the fallback, without waiting, when the asset will never arrive", () => {
    useIconThemeStore.setState((s) => ({
      resolved: { ...s.resolved, [KEY]: { kind: "image", definition: "ts" } },
    }));
    const root = slot();
    paintFileIcons(root);
    const el = root.querySelector<HTMLElement>("[data-file-icon]")!;
    // Resolved, asset in flight: it waits.
    expect(fileIconMarkup("/p/a.ts")).toBeUndefined();
    expect(waitingSlotCountForTests()).toBe(1);
    // The asset was stripped by the sanitiser, or failed to load.
    useIconThemeStore.setState({ missing: { ts: true } });
    expect(fileIconMarkup("/p/a.ts")).toBeNull();
    expect(el.innerHTML).toBe(FALLBACK);
    expect(el.dataset.fileIconPainted).toBe("fallback");
    expect(waitingSlotCountForTests()).toBe(0);
    // A later message with the same path does not wait either.
    paintFileIcons(slot());
    expect(waitingSlotCountForTests()).toBe(0);
  });

  it("drops detached slots while a streaming tail repaints", () => {
    // Each tick replaces the tail's HTML; nothing answers in between.
    for (let tick = 0; tick < 20; tick++) paintFileIcons(slot());
    expect(waitingSlotCountForTests()).toBe(1);
  });

  it("repaints a painted slot when the theme changes", () => {
    resolve();
    const root = slot();
    paintFileIcons(root);
    const el = root.querySelector<HTMLElement>("[data-file-icon]")!;
    expect(el.innerHTML).toBe(TS_SVG);
    // A new theme: caches dropped, the generation bumped, then its answer.
    useIconThemeStore.setState({ generation: 2, resolved: {}, prepared: {} });
    resolve('<svg fill="currentColor" data-other=""></svg>');
    expect(el.innerHTML).toBe('<svg fill="currentColor" data-other=""></svg>');
  });
});
