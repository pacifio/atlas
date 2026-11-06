// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_THEMES } from "@/dev/mock-backend/fixtures/builtin-themes";
import { applyTheme } from "@/features/theme/apply-theme";
import { DEFAULT_SETTINGS, type AppSettings } from "../lib/app-settings";

const applyConfiguredTheme = vi.fn();
const applyConfiguredIconTheme = vi.fn();
const updateAtlasConfig = vi.fn();
const setTelemetryEnabled = vi.fn();
let configChanged: ((payload: { settings: AppSettings; generation: number }) => void) | undefined;

vi.mock("@/features/theme/stores/theme-store", () => ({
  applyConfiguredTheme: (...args: unknown[]) => applyConfiguredTheme(...args),
}));
vi.mock("@/features/icon-theme/stores/icon-theme-store", () => ({
  applyConfiguredIconTheme: (...args: unknown[]) => applyConfiguredIconTheme(...args),
}));
vi.mock("@/features/telemetry/posthog-client", () => ({
  setEnabled: (...args: unknown[]) => setTelemetryEnabled(...args),
}));
vi.mock("@/features/settings/lib/ui-scale", () => ({ DEFAULT_SCALE: 1, applyUiScale: () => {} }));
vi.mock("@/features/settings/lib/atlas-config-api", () => ({
  updateSettings: (...args: unknown[]) => updateAtlasConfig(...args),
  resetConfig: vi.fn(),
  onConfigChanged: (callback: typeof configChanged) => {
    configChanged = callback;
    return Promise.resolve(() => {});
  },
  onConfigError: () => Promise.resolve(() => {}),
}));

const { useSettingsStore } = await import("./settings-store");

/** What IPC hands back: equal by value, never the same object. */
const fromRust = (settings: AppSettings): AppSettings => JSON.parse(JSON.stringify(settings));

const OVERRIDES = { base: { background: "navy" }, keys: { "syntax.keyword": "teal" } };

beforeEach(() => {
  useSettingsStore.getState().actions.hydrate({
    settings: {
      ...DEFAULT_SETTINGS,
      themeMode: "dark",
      themeOverrides: OVERRIDES,
    },
    configGeneration: 1,
  });
  vi.clearAllMocks();
});

describe("settings side effects", () => {
  /**
   * Every IPC result is a freshly parsed object, so a reference test on
   * `themeOverrides` re-applied the whole theme on every settings write —
   * once on the reconcile, again on the `atlas:config-changed` echo — and each
   * apply collapses mermaid diagrams and re-themes every terminal.
   */
  it("does not re-apply the theme for an unrelated setting", async () => {
    updateAtlasConfig.mockImplementation(async () => ({
      kind: "applied",
      settings: fromRust({ ...useSettingsStore.getState().settings, enterToSend: false }),
      generation: 2,
    }));

    useSettingsStore.getState().actions.updateSettings({ enterToSend: false });
    await vi.waitFor(() => expect(useSettingsStore.getState().configGeneration).toBe(2));
    configChanged?.({ settings: fromRust(useSettingsStore.getState().settings), generation: 3 });

    expect(applyConfiguredTheme).not.toHaveBeenCalled();
    expect(applyConfiguredIconTheme).not.toHaveBeenCalled();
  });

  it("does re-apply when an override actually changes", () => {
    const next = { ...OVERRIDES, keys: { "syntax.keyword": "olive" } };
    configChanged?.({
      settings: fromRust({ ...useSettingsStore.getState().settings, themeOverrides: next }),
      generation: 2,
    });

    expect(applyConfiguredTheme).toHaveBeenCalledTimes(1);
    expect(applyConfiguredTheme).toHaveBeenCalledWith(
      { light: "atlas", dark: "atlas" },
      "dark",
      next,
    );
  });

  it("ignores key order inside the overrides", () => {
    const reordered = { keys: OVERRIDES.keys, base: OVERRIDES.base };
    configChanged?.({
      settings: { ...useSettingsStore.getState().settings, themeOverrides: reordered },
      generation: 2,
    });
    expect(applyConfiguredTheme).not.toHaveBeenCalled();
  });
});

describe("icon appearance", () => {
  /**
   * Icons used to follow the REQUESTED mode. Monokai has no light variant, so
   * under Light it resolves — and paints — dark, and light icons on it were
   * the wrong half of the icon theme.
   */
  it("follows the appearance the theme actually resolved to", () => {
    const [rosePine, monokai] = ["rose-pine", "monokai"].map((id) =>
      BUILTIN_THEMES.find((theme) => theme.id === id)!,
    );
    // On a light theme under Light, icons are light.
    applyTheme(rosePine, "light");
    expect(applyConfiguredIconTheme).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.iconTheme, "light");

    // Switch to Monokai, still under Light. The mode did not change — the
    // appearance did — and what the theme store does once the file is loaded
    // is apply it.
    configChanged?.({
      settings: {
        ...useSettingsStore.getState().settings,
        themeLight: "monokai",
        themeMode: "light",
      },
      generation: 2,
    });
    applyTheme(monokai, "light");

    expect(applyConfiguredIconTheme).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.iconTheme, "dark");
  });

  it("uses the resolved appearance for a new icon theme, too", () => {
    const rosePine = BUILTIN_THEMES.find((theme) => theme.id === "rose-pine")!;
    applyTheme(rosePine, "light");
    vi.clearAllMocks();

    configChanged?.({
      settings: { ...useSettingsStore.getState().settings, iconTheme: "seti" },
      generation: 2,
    });

    expect(applyConfiguredIconTheme).toHaveBeenCalledTimes(1);
    expect(applyConfiguredIconTheme).toHaveBeenCalledWith("seti", "light");
  });
});

describe("telemetry side effect", () => {
  /** The crash reporter is frontend-only, so the store, not one switch, has to
   *  flip it: a reset, Restore defaults and a hand edit all go through here. */
  it("re-enables the crash reporter whenever shareTelemetry comes back on", async () => {
    useSettingsStore.getState().actions.hydrate({
      settings: {
        ...DEFAULT_SETTINGS,
        shareTelemetry: false,
      },
      configGeneration: 1,
    });
    configChanged?.({
      settings: { ...DEFAULT_SETTINGS },
      generation: 2,
    });
    await vi.waitFor(() => expect(setTelemetryEnabled).toHaveBeenLastCalledWith(true));
  });
});
