import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { applyUiScale } from "@/features/settings/lib/ui-scale";
import { applyConfiguredTheme } from "@/features/theme/stores/theme-store";
import { appearanceForMode, getActiveTheme } from "@/features/theme/apply-theme";
import { THEME_APPLIED_EVENT } from "@/features/theme/theme-values";
import { applyConfiguredIconTheme } from "@/features/icon-theme/stores/icon-theme-store";
import {
  updateSettings as updateAtlasConfig,
  resetConfig as resetAtlasConfig,
  onConfigChanged,
  onConfigError,
  type ConfigStatus,
  type SettingsPatch,
} from "@/features/settings/lib/atlas-config-api";
import { DEFAULT_SETTINGS, type AppSettings } from "@/features/settings/lib/app-settings";
import {
  migrateNotificationSettings,
  readLegacyAgentPrefs,
} from "@/features/settings/lib/notification-settings-migration";

// Re-exported because most of the app reaches for `AppSettings` through the
// store it reads settings from; the definition itself lives one directory over
// (see `../lib/app-settings.ts`).
export type { AppSettings };

interface SettingsState {
  settings: AppSettings;
  /** The generation of `settings` currently reflected here — every
   *  `updateSettings` call and every `atlas:config-changed` event advances
   *  it. See `atlas-config-api.ts`. */
  configGeneration: number;
  /** Set when `config.toml` is currently malformed (external edit or a
   *  rejected write) — `settings` still holds the last valid snapshot.
   *  `null` when there's nothing to report. Settings UI surfaces this. */
  configError: string | null;
  actions: {
    /** Applies + persists a settings change through `config.toml`
     *  (`update_atlas_settings`) — see `atlas-config-api.ts`. Optimistic:
     *  the store updates immediately, then reconciles with whatever Rust
     *  actually committed (a validation failure or a generation conflict
     *  rolls the optimistic change back to the last-known-good snapshot). */
    updateSettings: (partial: Partial<AppSettings>) => void;
    /** Dismiss the current `configError` banner without touching the file. */
    clearConfigError: () => void;
    /** "Recreate defaults" — the one action allowed to overwrite a malformed
     *  `config.toml` (Rust backs the old file up first). Owns the state write
     *  AND the resulting side effects, which is why the Settings panel calls
     *  this rather than reaching into `setState` itself. Rejects with the
     *  underlying error so the caller can toast it. */
    resetConfig: () => Promise<void>;
    /** One-shot hydration from the app bootstrap. Settings ride along in the
     *  `bootstrap_app_state` response for one round trip, but they come from
     *  `config.toml`, not `state.json` (issue #64) — so the app store hands
     *  that slice straight here and never persists it itself. */
    hydrate: (payload: {
      settings?: AppSettings;
      configGeneration?: number;
      configStatus?: ConfigStatus;
    }) => void;
  };
}

/** Structural equality for JSON-shaped settings values. Key order is ignored:
 *  the optimistic object is built in the UI and the reconciled one is parsed
 *  from Rust, and the two need not list the same keys in the same order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) {
    return false;
  }
  return keys.every((key) => sameValue(left[key], right[key]));
}

/** The icon theme + appearance last handed to `applyConfiguredIconTheme`, so a
 *  theme apply that leaves both where they were costs nothing. */
let appliedIcons: { id: string; appearance: "dark" | "light" } | null = null;

/** Icons follow the appearance the theme ACTUALLY resolved to, not the mode
 *  that was asked for: a dark-only theme (Monokai, Vesper) under Light paints
 *  dark, and light icons on it would be the wrong half of the theme's own
 *  `light` association section. Before the first apply there is no resolved
 *  theme yet, so the requested mode is the best guess — the
 *  `atlas:theme-applied` listener below corrects it the moment one lands. */
function applyIcons(iconTheme: string, themeMode: AppSettings["themeMode"]): void {
  const appearance = getActiveTheme()?.appearance ?? appearanceForMode(themeMode);
  if (appliedIcons?.id === iconTheme && appliedIcons.appearance === appearance) return;
  appliedIcons = { id: iconTheme, appearance };
  applyConfiguredIconTheme(iconTheme, appearance);
}

/** Re-apply every settings-driven side effect whose value actually changed
 *  between `previous` and `next`. Shared by `updateSettings` (both the
 *  optimistic apply and the reconciled result), `hydrate`, and the
 *  `atlas:config-changed` listener below — one path so a hot-reloaded
 *  external edit re-applies UI scale/theme/explorer state exactly like a
 *  UI-driven change does.
 *
 *  "Changed" is by VALUE. Every IPC result is a freshly parsed object, so a
 *  reference test on `themeOverrides` re-applied the whole theme on every
 *  settings write, twice (the reconcile and the `atlas:config-changed` echo) —
 *  and each apply collapses mermaid diagrams and re-themes every terminal. */
function applySettingsSideEffects(next: AppSettings, previous: AppSettings): void {
  // Toggling hidden-files visibility must re-apply the explorer's dotfile
  // filter immediately. `refresh()` reconciles the root and every expanded
  // subtree, so the user's expansion state survives.
  if (next.showHiddenFiles !== previous.showHiddenFiles) {
    void import("@/features/explorer/stores/explorer-store").then((m) =>
      m.useExplorerStore.getState().actions.refresh(),
    );
  }
  if (next.uiScale !== previous.uiScale) applyUiScale(next.uiScale);
  if (
    next.theme !== previous.theme ||
    next.themeMode !== previous.themeMode ||
    !sameValue(next.themeOverrides, previous.themeOverrides)
  ) {
    applyConfiguredTheme(next.theme, next.themeMode, next.themeOverrides);
  }
  // A theme or mode change reaches the icons through `atlas:theme-applied`,
  // once the appearance it resolves to is known; only a new icon theme has to
  // be applied from here.
  if (next.iconTheme !== previous.iconTheme) applyIcons(next.iconTheme, next.themeMode);
  // Agents are offered the code tools when a session opens, so an empty chat
  // opened while they were off is rebound to get them.
  if (next.agentCodeTools && !previous.agentCodeTools) {
    void import("@/features/chat/lib/rebind-empty-chats").then((m) => m.rebindEmptyChats());
  }
}

/** How many times a settings write adopts the latest generation and retries
 *  before giving up and telling the user. See `updateSettings`. */
const SETTINGS_WRITE_ATTEMPTS = 3;

/** Turn a boot-time `ConfigStatus` into the banner string, or `null` when the
 *  file loaded cleanly. */
function configErrorFrom(status: ConfigStatus | undefined): string | null {
  if (!status || status.status === "ok") return null;
  return status.status === "usingDefaults"
    ? `config.toml could not be loaded, so Atlas is running on default settings — your saved preferences are not applied. ${status.error}`
    : `config.toml is currently invalid; Atlas is running on the last settings that loaded cleanly. ${status.error}`;
}

export const useSettingsStore = createSelectors(
  create<SettingsState>()((set, get) => ({
    settings: DEFAULT_SETTINGS,
    configGeneration: 0,
    configError: null,
    actions: {
      updateSettings: (partial: Partial<AppSettings>) => {
        // Optimistic: apply immediately so the control feels instant, then
        // reconcile with whatever `config.toml` actually ends up holding.
        // Rust validates the full candidate and can reject it outright, or —
        // on a stale `configGeneration` — refuse to apply and return a
        // Conflict instead (see `atlas-config-api.ts`). A generation can go
        // stale without any UI involvement at all (an internal Rust-side
        // write, e.g. the Local Model Manager persisting a model switch, or
        // an external edit), so a Conflict here does NOT mean someone else
        // wanted this same key — it just means the base this patch was
        // computed against is out of date. Adopt the fresh generation and
        // retry the original patch; only surface an error once
        // `SETTINGS_WRITE_ATTEMPTS` of them have conflicted in a row (an
        // actual sustained race, not just staleness). A single retry wasn't
        // enough: during a burst of rapid changes — dragging the zoom slider,
        // say — a second unrelated write can land between the retry and its
        // read, silently dropping the user's action.
        const previous = get().settings;
        const optimistic = { ...previous, ...partial };
        set({ settings: optimistic });
        applySettingsSideEffects(optimistic, previous);

        const attempt = (generation: number, attemptsLeft: number) => {
          updateAtlasConfig(partial as SettingsPatch, generation)
            .then((outcome) => {
              if (outcome.kind === "conflict") {
                if (attemptsLeft <= 1) {
                  console.warn(
                    "updateSettings: still conflicting after adopting the latest generation",
                  );
                  set({
                    settings: outcome.settings,
                    configGeneration: outcome.generation,
                    configError:
                      "Settings change conflicted with a concurrent edit — please try again.",
                  });
                  applySettingsSideEffects(outcome.settings, optimistic);
                  return;
                }
                set({ configGeneration: outcome.generation });
                attempt(outcome.generation, attemptsLeft - 1);
                return;
              }
              set({
                settings: outcome.settings,
                configGeneration: outcome.generation,
                configError: null,
              });
              applySettingsSideEffects(outcome.settings, optimistic);
            })
            .catch((e) => {
              console.warn("update_atlas_settings failed:", e);
              set({ settings: previous, configError: String(e) });
              applySettingsSideEffects(previous, optimistic);
            });
        };
        attempt(get().configGeneration, SETTINGS_WRITE_ATTEMPTS);
      },
      clearConfigError: () => set({ configError: null }),
      resetConfig: async () => {
        const previous = get().settings;
        const snapshot = await resetAtlasConfig();
        set({
          settings: snapshot.settings,
          configGeneration: snapshot.generation,
          configError: null,
        });
        applySettingsSideEffects(snapshot.settings, previous);
      },
      hydrate: (payload) => {
        // Merge with defaults so an older/mid-migration response missing a
        // brand-new key gets the modern default rather than `undefined` —
        // belt-and-suspenders on top of Rust's own field-level defaulting.
        const settings: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...payload.settings,
        };
        set({
          settings,
          configGeneration: payload.configGeneration ?? 0,
          // A `config.toml` that failed to load at startup is the one case the
          // user cannot otherwise notice: every preference silently reads back
          // as an Atlas default (`shareTelemetry` included). Rust computes the
          // status at boot; hard-nulling it here is what kept it off screen.
          configError: configErrorFrom(payload.configStatus),
        });

        // Re-apply the persisted interface zoom (needs the Tauri WebView API,
        // so it can only run here, not in the pre-mount boot path).
        applyUiScale(settings.uiScale);
        // Resolve and apply the one persisted theme across chrome, editor,
        // terminal, diffs and syntax variables.
        applyConfiguredTheme(settings.theme, settings.themeMode, settings.themeOverrides);
        // The icon catalog is only listed here; no icon is fetched until a
        // row asks for one (decision 12).
        applyIcons(settings.iconTheme, settings.themeMode);

        // Fold the pre-tier terminal + agent notification choices into the
        // tier settings, once (the flag it sets is persisted with the patch).
        // Not while the file is unreadable: those are defaults, not choices.
        const migration =
          !payload.configStatus || payload.configStatus.status === "ok"
            ? migrateNotificationSettings(settings, readLegacyAgentPrefs())
            : null;
        if (migration) get().actions.updateSettings(migration);
      },
    },
  })),
);

// `config.toml` can change for reasons other than this window's own
// `updateSettings` call: the Settings UI edited it in another window (not
// currently possible — Atlas is single-window — but this is also what fires
// for a `reset_atlas_config`), or an external editor / the
// `atlas-self-configure` skill wrote to it directly. Both land here as a hot
// reload; `applySettingsSideEffects` re-applies exactly the side effects that
// actually changed, same as a UI-driven update.
//
// Behind the same `window` guard as the listener below: this module is pulled
// in transitively by code that unit-tests under vitest's `node` environment
// (`author-directory.test.ts` via the org directory), where Tauri's `listen`
// throws on the missing `window` — and `void` turned that into an unhandled
// rejection that failed the whole run.
if (typeof window !== "undefined") {
  void onConfigChanged(({ settings, generation }) => {
    const previous = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings, configGeneration: generation, configError: null });
    applySettingsSideEffects(settings, previous);
  });
}

// Every theme apply — a settings change, the OS flipping appearance under
// `system`, a hot-reloaded theme file — can change the appearance the icons
// should follow. See `applyIcons`.
if (typeof window !== "undefined") {
  window.addEventListener(THEME_APPLIED_EVENT, () => {
    const { settings } = useSettingsStore.getState();
    applyIcons(settings.iconTheme, settings.themeMode);
  });
}

// A malformed external edit (or a write Rust rejected) — `settings` is
// unchanged, this is purely "tell the user".
if (typeof window !== "undefined") {
  void onConfigError((error) => {
    useSettingsStore.setState({ configError: error });
  });
}
