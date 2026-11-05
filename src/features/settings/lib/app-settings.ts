/**
 * The `AppSettings` schema and its defaults.
 *
 * Both are generated from the settings registry, `src-tauri/settings-registry.toml`,
 * into `settings-registry.gen.ts` (`bun run settings:gen`); this module is the
 * stable import path the rest of the app uses. A Rust test holds the
 * `AppSettings` struct in `src-tauri/src/state/atlas_config.rs` to the same
 * registry, so the two sides cannot drift.
 *
 * Lives in the settings feature (not the project store) because that is the
 * domain that owns it: `atlas-config-api.ts` needs the type to describe its
 * own IPC surface, and importing it back out of the project store — which in
 * turn imports the api wrapper and runs listener registration at module scope
 * — made the two modules a cycle.
 */

import type { AppSettings } from "./settings-registry.gen";

export {
  DEFAULT_SETTINGS,
  SETTINGS_PAGES,
  SETTINGS_REGISTRY,
  type AppSettings,
  type SettingKey,
  type SettingMeta,
  type SettingStatus,
  type SettingsPageId,
} from "./settings-registry.gen";

/** Settings keys holding a plain on/off — the tier banner and sound switches name these. */
export type BooleanSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];
