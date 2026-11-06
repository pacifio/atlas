import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { OpenVsxExtension } from "@/lib/open-vsx";

/**
 * The icon-theme IPC surface (decisions 4, 11, 12).
 *
 * Mirrors `src-tauri/src/commands/icon_themes.rs` and the types
 * `crates/atlas-icon-theme` serialises. Keep the two in step: `bun run
 * typecheck` checks the mock fixtures against these types, but nothing checks
 * these types against Rust.
 */

/** Atlas's own lucide icons — the opt-out. */
export const MINIMAL_ICON_THEME_ID = "minimal";
/** The bundled default (decision 12). */
export const MATERIAL_ICON_THEME_ID = "material-icon-theme";

export type IconKind = "file" | "folder" | "folderExpanded" | "rootFolder" | "rootFolderExpanded";

/** Which of a theme's three association sets applies. */
export type IconAppearance = "dark" | "light" | "highContrast";

export interface IconThemeWarning {
  key: string;
  message: string;
}

export interface IconThemeSummary {
  id: string;
  name: string;
  author: string;
  license: string;
  builtIn: boolean;
  /** The theme draws open/closed folders itself and wants no twisty chevron. */
  hidesExplorerArrows: boolean;
  /** No document at all: keep rendering Atlas's own icons. */
  usesFallbackIcons: boolean;
  warnings?: IconThemeWarning[];
}

export interface IconRequest {
  path: string;
  kind: IconKind;
  /** The editor's language id, when the path has one. */
  languageId?: string;
}

/**
 * What to draw for one path.
 *
 * An image carries only its definition id — the bytes come from a second,
 * batched, deduplicated call, which is what keeps a 1 MB icon theme off the
 * startup path. A glyph carries everything inline, because a round trip would
 * cost more than the character does.
 */
export type ResolvedIcon =
  | { kind: "image"; definition: string }
  | {
      kind: "glyph";
      definition: string;
      character: string;
      color?: string;
      size?: string;
      fontId?: string;
    };

export type IconAsset = { kind: "svg"; source: string } | { kind: "dataUrl"; url: string };

export interface IconFontData {
  format: string;
  url: string;
}

export interface IconFontFace {
  id: string;
  weight?: string;
  style?: string;
  size?: string;
  src: IconFontData[];
}

export const ICON_THEMES_CHANGED_EVENT = "atlas:icon-themes-changed";

export function listIconThemes(): Promise<IconThemeSummary[]> {
  return invoke("list_icon_themes");
}

export function resolveIcons(
  themeId: string,
  appearance: IconAppearance,
  requests: IconRequest[],
): Promise<(ResolvedIcon | null)[]> {
  return invoke("resolve_icons", { themeId, appearance, requests });
}

export function getIconThemeAssets(
  themeId: string,
  definitions: string[],
): Promise<Record<string, IconAsset>> {
  return invoke("get_icon_theme_assets", { themeId, definitions });
}

export function getIconThemeFonts(themeId: string): Promise<IconFontFace[]> {
  return invoke("get_icon_theme_fonts", { themeId });
}

export function searchIconThemes(query: string): Promise<OpenVsxExtension[]> {
  return invoke("search_icon_themes", { query });
}

export function installIconTheme(args: {
  namespace: string;
  name: string;
  version?: string;
}): Promise<IconThemeSummary> {
  return invoke("install_icon_theme", { args });
}

export function removeIconTheme(id: string): Promise<void> {
  return invoke("remove_icon_theme", { id });
}

export function onIconThemesChanged(callback: () => void): Promise<UnlistenFn> {
  return listen(ICON_THEMES_CHANGED_EVENT, callback);
}
