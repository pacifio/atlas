/**
 * One setting as the Settings page in front of the user sees it: the global
 * value under "All projects", or a project's value under that project's scope.
 *
 * Every row and bound control reads through this, so the scope picker
 * (`ScopeSentence`) changes what the whole page shows and writes in one place,
 * as follows:
 *
 * - **All projects.** Reads and writes `config.toml`. Reset puts the default
 *   back.
 * - **A project, for a key it can override** (`SettingMeta.project`). Shows
 *   the project's value: its override, else the inherited global one. A
 *   change writes the override; reset removes it, so the global value
 *   applies again.
 * - **A project, for any other key.** Shown read-only with the global value:
 *   it applies to every project.
 * - **A tighten-only key that is off for all projects** (`project:
 *   "tighten"`: an agent permission, a data-sending job). Read-only under a
 *   project: a project can turn it off, never on, because a repository can
 *   commit the file that would.
 */

import { createContext, useContext, useEffect } from "react";
import { useSettingsStore } from "../stores/settings-store";
import { projectValue, useProjectSettingsStore } from "../stores/project-settings-store";
import { DEFAULT_SETTINGS, type AppSettings, type SettingKey } from "./app-settings";
import { isDefaultValue, settingMeta } from "./settings-sections";

/**
 * The scope the page in front of the user edits. Only a page that shows the
 * scope picker provides one (`SettingsPage scopeable`), so a page with no
 * per-project settings always edits the global file, whatever was picked on
 * another page.
 */
export const PageScopeContext = createContext<string | null>(null);

/** `null` for all projects, or the path of the project being edited. */
export function usePageScope(): string | null {
  return useContext(PageScopeContext);
}

export interface ScopedSetting<K extends SettingKey> {
  value: AppSettings[K];
  /** Under a project scope, for a key it cannot change there. */
  globalOnly: boolean;
  /** Why, when it is not simply a global-only key. */
  lockedReason: string | null;
  /** Whether the reset button has something to undo. */
  resettable: boolean;
  /** "Reset to default" or "Reset to the value for all projects". */
  resetLabel: string;
  /** Under a project scope, the project sets this key itself. */
  overridden: boolean;
  /** The value under "All projects", for the inheritance hint. */
  globalValue: AppSettings[K];
  set: (next: AppSettings[K]) => void;
  reset: () => void;
}

/** Load a project's overrides the first time something asks for them. */
export function useLoadProjectSettings(projectPath: string | null | undefined) {
  const loaded = useProjectSettingsStore((s) => (projectPath ? projectPath in s.byPath : true));
  useEffect(() => {
    if (projectPath && !loaded) void useProjectSettingsStore.getState().actions.load(projectPath);
  }, [projectPath, loaded]);
}

export function useScopedSetting<K extends SettingKey>(key: K): ScopedSetting<K> {
  const scope = usePageScope();
  const globalValue = useSettingsStore((s) => s.settings[key]);
  const settings = useSettingsStore.use.settings();
  const { updateSettings } = useSettingsStore.use.actions();
  const byPath = useProjectSettingsStore.use.byPath();
  const { update } = useProjectSettingsStore.use.actions();
  useLoadProjectSettings(scope);

  const scopable = Boolean(settingMeta(key)?.project);
  if (scope === null || !scopable) {
    return {
      value: globalValue,
      globalOnly: scope !== null,
      lockedReason: null,
      resettable: scope === null && !isDefaultValue(key, globalValue),
      resetLabel: "Reset to default",
      overridden: false,
      globalValue,
      set: (next) => void updateSettings({ [key]: next } as Partial<AppSettings>),
      reset: () => void updateSettings({ [key]: DEFAULT_SETTINGS[key] } as Partial<AppSettings>),
    };
  }
  const values = byPath[scope]?.values ?? {};
  const overridden = key in values;
  // Locked even with an override in place (an "off" set before the global
  // value went off too): switching it on would be refused. Reset stays
  // available to drop the redundant override.
  const tightenLocked = settingMeta(key)?.project === "tighten" && globalValue === false;
  return {
    value: projectValue(byPath, scope, key, settings),
    globalOnly: tightenLocked,
    lockedReason: tightenLocked
      ? "Off for all projects. A project can turn this off, never on: turn it on for all projects first."
      : null,
    resettable: overridden,
    resetLabel: "Use the value for all projects",
    overridden,
    globalValue,
    set: (next) => void update(scope, { [key]: next }),
    reset: () => void update(scope, { [key]: null }),
  };
}

/** The value of a per-project key inside `projectPath`, for code that acts in
 *  a project (the editor's inline blame). Loads the project's file on first use. */
export function useProjectSetting<K extends SettingKey>(
  projectPath: string | null | undefined,
  key: K,
): AppSettings[K] {
  useLoadProjectSettings(projectPath);
  const settings = useSettingsStore.use.settings();
  const byPath = useProjectSettingsStore.use.byPath();
  return projectValue(byPath, projectPath, key, settings);
}

/** The same, read once outside React. */
export function projectSettingNow<K extends SettingKey>(
  projectPath: string | null | undefined,
  key: K,
): AppSettings[K] {
  return projectValue(
    useProjectSettingsStore.getState().byPath,
    projectPath,
    key,
    useSettingsStore.getState().settings,
  );
}
