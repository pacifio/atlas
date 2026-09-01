import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings } from "@/features/project/stores/project-store";

/**
 * `config.toml` bridge — the validated, human/agent-editable settings file
 * that replaced `AppState.settings` inside `state.json` (issue #64).
 *
 * Rust owns the schema, defaults, validation and persistence; this module is
 * the thin `invoke`/`listen` wrapper isolating that IPC surface, per the
 * repo's `lib/<domain>-api.ts` convention. `updateSettings` (below) is what
 * every settings-changing UI action should call — never `invoke` these
 * commands directly from a component.
 */

/** Every field optional — send only the keys actually changing. `null` for
 *  `updaterIgnoredVersion` clears it; omitting the key leaves it untouched. */
export type SettingsPatch = Partial<Omit<AppSettings, "updaterIgnoredVersion">> & {
  updaterIgnoredVersion?: string | null;
};

export type ConfigStatus =
  | { status: "ok" }
  | { status: "usingLastKnownGood"; error: string }
  | { status: "usingDefaults"; error: string };

export interface ConfigInfo {
  path: string;
  schemaVersion: number;
  status: ConfigStatus;
  effectiveSettings: AppSettings;
  generation: number;
  unknownKeys: string[];
}

export type UpdateOutcome =
  | { kind: "applied"; settings: AppSettings; generation: number }
  | { kind: "conflict"; settings: AppSettings; generation: number };

export function getConfigInfo(): Promise<ConfigInfo> {
  return invoke<ConfigInfo>("get_atlas_config_info");
}

export function updateSettings(
  patch: SettingsPatch,
  expectedGeneration: number,
): Promise<UpdateOutcome> {
  return invoke<UpdateOutcome>("update_atlas_settings", { patch, expectedGeneration });
}

export function resetConfig(): Promise<{ settings: AppSettings; generation: number }> {
  return invoke("reset_atlas_config");
}

export function openConfigFile(): Promise<void> {
  return invoke("open_atlas_config");
}

interface ConfigChangedPayload {
  settings: AppSettings;
  generation: number;
}

/** Fires whenever `config.toml` changes for any reason other than the
 *  current window's own successful `updateSettings` call, which already gets
 *  the new snapshot back as that call's return value — the frontend's own
 *  round trip, and this event, are two different delivery paths for the same
 *  kind of change. */
export function onConfigChanged(cb: (payload: ConfigChangedPayload) => void): Promise<UnlistenFn> {
  return listen<ConfigChangedPayload>("atlas:config-changed", (e) => cb(e.payload));
}

/** Fires when an external edit (or a rejected patch) leaves `config.toml`
 *  invalid — the file was NOT touched and the previous settings are still
 *  effective; this is purely a "tell the user" signal. */
export function onConfigError(cb: (error: string) => void): Promise<UnlistenFn> {
  return listen<{ error: string }>("atlas:config-error", (e) => cb(e.payload.error));
}
