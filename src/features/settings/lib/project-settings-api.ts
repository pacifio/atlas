import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, SettingKey } from "./app-settings";

/**
 * Per-project settings: `<project>/.atlas/config.toml`, a sparse overlay on
 * the global `config.toml` holding only the keys a project changes. Only keys
 * the registry marks `project` can be set there (`SettingMeta.project`).
 *
 * Rust owns the file, the overlay and the validation
 * (`state/project_config.rs`); this is the IPC wrapper.
 */
export interface ProjectSettingsInfo {
  /** The file's path, whether or not it exists yet. */
  path: string;
  /** Each override in effect, already validated against the global settings. */
  values: Partial<AppSettings>;
  /** Keys in the file that cannot be set per project; left there, never applied. */
  ignoredKeys: string[];
  /** Keys a project may only turn off that the file tries to switch on while
   *  they are off for all projects. Never applied: a repository can commit
   *  this file, so it must not grant what the user withheld. */
  refusedKeys: string[];
  /** Why nothing in the file is applied (bad TOML, an invalid value). */
  error: string | null;
}

/** A value sets the override; `null` removes it, so the global value applies. */
export type ProjectSettingsPatch = Partial<Record<SettingKey, unknown>>;

export function getProjectSettings(projectPath: string): Promise<ProjectSettingsInfo> {
  return invoke<ProjectSettingsInfo>("get_project_settings", { projectPath });
}

export function updateProjectSettings(
  projectPath: string,
  patch: ProjectSettingsPatch,
): Promise<ProjectSettingsInfo> {
  return invoke<ProjectSettingsInfo>("update_project_settings", { projectPath, patch });
}
