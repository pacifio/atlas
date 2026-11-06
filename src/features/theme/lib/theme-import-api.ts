import { invoke } from "@tauri-apps/api/core";
import type { OpenVsxExtension } from "@/lib/open-vsx";
import type { Theme } from "@tryatlas/design/theme";

/**
 * Theme import and export (decision 15).
 *
 * The conversion is Rust's: `crates/atlas-theme/src/import` owns every mapping
 * table, and the frontend never parses a foreign theme. These types mirror
 * that crate's `serde` output, so a mapping change that alters the report shape
 * fails `bun run typecheck` here rather than rendering blank in the panel.
 *
 * The flow is preview-then-commit on purpose: a VS Code import is lossy by
 * construction and the user has to be able to read what happened before it
 * becomes a file in `~/.config/atlas/themes/`.
 */

export type ThemeImportFormat = "shadcn" | "shadcn-css" | "zed" | "vs-code";

/** How close the converted theme can get to its source, by construction. */
export type ThemeFidelity = "native" | "near-lossless" | "lossy";

/** Whether committing would create, replace, or shadow a built-in. */
export type ThemeOrigin = "new" | "user" | "built-in";

/** A value the source provided and Atlas kept. */
export interface MappedThemeKey {
  /** Fully qualified: `dark.base.background`. */
  target: string;
  /** The source's own name for it. */
  source: string;
  value: string;
}

/** A value Atlas invented because the source had none. */
export interface DerivedThemeKey {
  target: string;
  /** The token it came from, or `"atlas default"`. */
  from: string;
  value: string;
}

/** Something the source said that Atlas has no home for. */
export interface IgnoredThemeKey {
  source: string;
  category: string;
  reason: string;
}

export interface ThemeImportCounts {
  mapped: number;
  derived: number;
  ignored: number;
  ignoredByCategory: Record<string, number>;
}

export interface ThemeImportReport {
  format: string;
  sourceName: string;
  variants: string[];
  fidelity: ThemeFidelity;
  /** What the format cannot carry. The part a user must read. */
  summary: string[];
  mapped: MappedThemeKey[];
  derived: DerivedThemeKey[];
  ignored: IgnoredThemeKey[];
  warnings: string[];
  counts: ThemeImportCounts;
}

export interface ThemeImportCandidate {
  id: string;
  name: string;
  author: string;
  license: string;
  variants: string[];
  /** Exactly what `commitThemeImport` would write. */
  toml: string;
  theme: Theme;
  report: ThemeImportReport;
  existing: ThemeOrigin;
}

export interface ThemeImportPreview {
  origin: string;
  format: string;
  /** One per theme in the source; a Zed family has several. */
  themes: ThemeImportCandidate[];
  /** A theme in the source that could not be imported, and why. Only an
   *  Open VSX extension, which carries several files, has any. */
  skipped: string[];
}

export interface ThemeImportInput {
  text?: string;
  url?: string;
  path?: string;
  format?: ThemeImportFormat;
  /** A colour-theme extension on Open VSX; omitting `version` takes the latest. */
  openVsx?: { namespace: string; name: string; version?: string };
}

export interface ShadcnExportReport {
  exported: number;
  dropped: number;
  droppedByCategory: Record<string, number>;
  notes: string[];
}

export interface ShadcnExport {
  id: string;
  name: string;
  /** The registry item, pretty-printed and ready to copy. */
  json: string;
  variants: string[];
  report: ShadcnExportReport;
}

/** Open VSX extensions that contribute a colour theme. */
export function searchColorThemes(query: string): Promise<OpenVsxExtension[]> {
  return invoke("search_color_themes", { query });
}

/** Convert and report. Writes nothing. */
export function previewThemeImport(input: ThemeImportInput): Promise<ThemeImportPreview> {
  return invoke("preview_theme_import", { input });
}

/** What `commitThemeImport` wrote. */
export interface CommittedThemeImport {
  /** The id the theme was saved under: the text the user typed, slugged.
   *  This, not the typed text, is what `settings.theme` must name. */
  id: string;
  path: string;
}

/** Write a previewed theme to `~/.config/atlas/themes/<id>.toml`. */
export function commitThemeImport(
  toml: string,
  id: string,
  name: string,
): Promise<CommittedThemeImport> {
  return invoke("commit_theme_import", { toml, id, name });
}

/** `fold` in `crates/atlas-theme/src/import/mod.rs`, one entry per run. */
const SLUG_FOLDS: [RegExp, string][] = [
  [/[à-åÀ-Åāăą]/, "a"],
  [/[è-ëÈ-Ëēėę]/, "e"],
  [/[ì-ïÌ-Ïīį]/, "i"],
  [/[ò-öÒ-ÖøØō]/, "o"],
  [/[ù-üÙ-Üū]/, "u"],
  [/[çÇćč]/, "c"],
  [/[ñÑń]/, "n"],
  [/[ýÿ]/, "y"],
  [/[šś]/, "s"],
  [/[žźż]/, "z"],
  [/ß/, "ss"],
  [/[æÆ]/, "ae"],
];

/**
 * The id `commit_theme_import` will save under for what the user typed —
 * `atlas_theme::import::slug`, character for character. Only used to label the
 * preview ("Replaces an import"); the id that is applied is the one Rust
 * returns from the commit.
 */
export function themeIdSlug(text: string): string {
  let out = "";
  for (const ch of text) {
    let folded = "";
    if (/^[A-Za-z0-9]$/.test(ch)) folded = ch.toLowerCase();
    else folded = SLUG_FOLDS.find(([pattern]) => pattern.test(ch))?.[1] ?? "";
    if (folded) out += folded;
    else if (!out.endsWith("-")) out += "-";
  }
  return out.replace(/^-+|-+$/g, "");
}

export function exportThemeShadcn(id: string): Promise<ShadcnExport> {
  return invoke("export_theme_shadcn", { id });
}

export const FIDELITY_LABEL: Record<ThemeFidelity, string> = {
  native: "Nothing lost",
  "near-lossless": "Near-lossless",
  lossy: "Lossy",
};
