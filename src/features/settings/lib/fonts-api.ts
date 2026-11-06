/**
 * The font families installed on this machine, for the font pickers.
 *
 * Rust answers on macOS (CoreText) and Linux (fontconfig), each with which
 * families are fixed-width (`commands/fonts.rs`). On Windows it answers `null`
 * and the webview, which is Chromium there, lists them with
 * `queryLocalFonts()` instead; that API has no monospace flag, so it is
 * measured. Where neither works the list is empty and the picker still takes
 * a typed font list.
 *
 * Read fresh each time a picker opens, so a font installed while Atlas runs
 * shows up without a restart.
 */

import { invoke } from "@tauri-apps/api/core";

export interface FontFamily {
  /** The family name, as CSS `font-family` takes it. */
  name: string;
  /** Every glyph the same width — what code and the terminal need. */
  monospace: boolean;
}

export async function listFontFamilies(): Promise<FontFamily[]> {
  try {
    const native = await invoke<FontFamily[] | null>("list_font_families");
    if (native) return native;
  } catch {
    // Fall through to the webview's own listing.
  }
  return queryLocalFamilies();
}

async function queryLocalFamilies(): Promise<FontFamily[]> {
  const query = (window as { queryLocalFonts?: () => Promise<ReadonlyArray<{ family: string }>> })
    .queryLocalFonts;
  if (typeof query !== "function") return [];
  try {
    const faces = await query.call(window);
    const names = [...new Set(faces.map((face) => face.family))].sort((a, b) => a.localeCompare(b));
    return names.map((name) => ({ name, monospace: measuresMonospace(name) }));
  } catch {
    return [];
  }
}

let probe: CanvasRenderingContext2D | null | undefined;

/** Narrow and wide glyphs the same width in `family`. Falls back to a
 *  proportional generic, so a family the canvas cannot use reads as not
 *  monospace rather than borrowing a monospace fallback's widths. */
export function measuresMonospace(family: string): boolean {
  if (probe === undefined) probe = document.createElement("canvas").getContext("2d");
  if (!probe) return false;
  probe.font = `16px "${family.replaceAll('"', "")}", serif`;
  const narrow = probe.measureText("iiiiiiiiii").width;
  const wide = probe.measureText("WWWWWWWWWW").width;
  return narrow > 0 && Math.abs(narrow - wide) < 0.5;
}

/**
 * A setting's value read as the picker shows it: empty (the default), one
 * family, or a hand-written fallback list.
 */
export type FontValue =
  | { kind: "default" }
  | { kind: "family"; family: string }
  | { kind: "list"; families: string[] };

export function parseFontValue(value: string): FontValue {
  const families = value
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  if (families.length === 0) return { kind: "default" };
  if (families.length === 1) return { kind: "family", family: families[0] };
  return { kind: "list", families };
}

/** A family name as a CSS `font-family` value: quoted when it has a space. */
export function cssFamily(name: string): string {
  return /^[\w-]+$/.test(name) ? name : `"${name.replaceAll('"', "")}"`;
}
