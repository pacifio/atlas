import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Theme, ThemeWarning } from "@tryatlas/design/theme";

export interface ThemeSummary {
  id: string;
  name: string;
  author: string;
  license: string;
  hasDark: boolean;
  hasLight: boolean;
  builtIn: boolean;
  warnings: ThemeWarning[];
}

/** The picker's whole view of disk: what loaded, and what did not. */
export interface ThemeCatalogSummary {
  themes: ThemeSummary[];
  /** One entry per user theme file that could not be loaded at all, keyed by
   *  file name. Empty on a healthy install. */
  warnings: ThemeWarning[];
}

export const THEMES_CHANGED_EVENT = "atlas:themes-changed";

export function listThemes(): Promise<ThemeCatalogSummary> {
  return invoke("list_themes");
}

export function getTheme(id: string): Promise<Theme> {
  return invoke("get_theme", { id });
}

/** Where `saveTheme` wrote. */
export interface SavedTheme {
  /** The id it was saved under, slugged: what `themeDark`/`themeLight` name. */
  id: string;
  path: string;
}

/** Write a theme from the theme editor to `~/.config/atlas/themes/<id>.toml`.
 *  It carries only what the author set; the rest derives (ADR-0022). */
export function saveTheme(theme: Theme): Promise<SavedTheme> {
  return invoke("save_theme", { theme });
}

export function onThemesChanged(callback: () => void): Promise<UnlistenFn> {
  return listen(THEMES_CHANGED_EVENT, callback);
}
