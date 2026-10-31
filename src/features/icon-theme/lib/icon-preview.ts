import { detectLanguage, PLAINTEXT } from "./language-id";
import { sanitizeSvg } from "./sanitize-svg";
import { fontFaceCss, safeFontIdent } from "./font-face-css";
import {
  getIconThemeAssets,
  getIconThemeFonts,
  resolveIcons,
  MINIMAL_ICON_THEME_ID,
  type IconAppearance,
  type IconAsset,
  type IconFontFace,
  type IconKind,
} from "./icon-theme-api";

/**
 * A few file rows resolved against ONE icon theme, whichever theme is active.
 *
 * The picker had the same defect the colour-theme picker had: a grid of names.
 * The one preview strip it carried showed the theme already applied, which is
 * the one theme you do not need to be shown. `resolve_icons` and
 * `get_icon_theme_assets` both take the theme id as an argument, so a card can
 * ask for its own icons without anything being applied — this module is that
 * call, plus the caching that keeps it to one round trip per theme.
 *
 * Deliberately NOT routed through `icon-theme-store`: that store is the ACTIVE
 * theme, keyed by path alone, and emptied wholesale on a switch. Teaching it
 * about a second theme would make every cache key in it ambiguous, for a
 * six-icon strip. This keeps its own small cache and its own font families.
 */

/** The rows every card shows. Fixed, so two cards differ only in the icons. */
export const ICON_PREVIEW_ROW: { path: string; kind: IconKind }[] = [
  { path: "src/main.ts", kind: "file" },
  { path: "src/App.tsx", kind: "file" },
  { path: "Cargo.toml", kind: "file" },
  { path: "package.json", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: "src", kind: "folder" },
];

export type PreviewIcon =
  | { kind: "svg"; svg: string }
  | { kind: "url"; url: string }
  | { kind: "glyph"; character: string; color?: string; fontFamily?: string }
  | null;

export interface IconThemePreview {
  /** One entry per `ICON_PREVIEW_ROW`; `null` means "draw the lucide icon". */
  icons: PreviewIcon[];
  /** `@font-face` rules a glyph theme needs, or `""`. Inject as-is. */
  fontFaces: string;
}

const EMPTY: IconThemePreview = { icons: ICON_PREVIEW_ROW.map(() => null), fontFaces: "" };

/**
 * A font family scoped to the preview.
 *
 * `IconThemeFonts` registers the ACTIVE theme's faces as
 * `atlas-icon-font-<fontId>`, and two different themes can both call their
 * font `seti`. Prefixing with the theme id keeps a card from rendering its
 * glyphs in another theme's font.
 */
function previewFamily(themeId: string, fontId: string): string {
  // Both halves come from an installed theme, so both go through the same
  // reduction the `@font-face` text does — see `font-face-css.ts`.
  return safeFontIdent(`atlas-icon-preview-${themeId}-${fontId}`);
}

function faceCss(themeId: string, fonts: IconFontFace[]): string {
  return fonts
    .map((font) => fontFaceCss(previewFamily(themeId, font.id), font))
    .filter(Boolean)
    .join("\n");
}

async function build(themeId: string, appearance: IconAppearance): Promise<IconThemePreview> {
  // "Minimal" is not an empty theme, it is no theme — every row keeps its
  // lucide icon, which is exactly what `null` draws.
  if (themeId === MINIMAL_ICON_THEME_ID) return EMPTY;

  const answers = await resolveIcons(
    themeId,
    appearance,
    ICON_PREVIEW_ROW.map(({ path, kind }) => {
      // The editor's own language table, the same source `FileIcon` uses, so
      // a card resolves through the same precedence a real row does.
      const detected = kind === "file" ? detectLanguage(path) : PLAINTEXT;
      return { path, kind, languageId: detected === PLAINTEXT ? undefined : detected };
    }),
  );

  const definitions = new Set<string>();
  let glyphs = false;
  for (const answer of answers) {
    if (!answer) continue;
    if (answer.kind === "glyph") glyphs = true;
    else definitions.add(answer.definition);
  }

  const [assets, fonts] = await Promise.all([
    definitions.size > 0
      ? getIconThemeAssets(themeId, [...definitions])
      : Promise.resolve<Record<string, IconAsset>>({}),
    glyphs ? getIconThemeFonts(themeId) : Promise.resolve<IconFontFace[]>([]),
  ]);

  const icons = answers.map((answer): PreviewIcon => {
    if (!answer) return null;
    if (answer.kind === "glyph") {
      return {
        kind: "glyph",
        character: answer.character,
        color: answer.color,
        fontFamily: answer.fontId ? previewFamily(themeId, answer.fontId) : undefined,
      };
    }
    const asset = assets[answer.definition];
    if (!asset) return null;
    if (asset.kind !== "svg") return { kind: "url", url: asset.url };
    // Sanitised before it can reach `dangerouslySetInnerHTML`, on the same
    // allowlist the active theme's assets go through.
    const svg = sanitizeSvg(asset.source);
    return svg ? { kind: "svg", svg } : null;
  });

  return { icons, fontFaces: faceCss(themeId, fonts) };
}

const cache = new Map<string, Promise<IconThemePreview>>();

/** Resolve `themeId`'s preview row, at most once per theme and appearance. */
export function loadIconThemePreview(
  themeId: string,
  appearance: IconAppearance,
): Promise<IconThemePreview> {
  const key = `${themeId}|${appearance}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = build(themeId, appearance).catch((error: unknown) => {
    // An icon theme is an ornament. A card that could not fetch one falls back
    // to the lucide row and lets the next mount try again, rather than caching
    // the failure for the session.
    console.warn(`Icon theme preview for "${themeId}" failed`, error);
    cache.delete(key);
    return EMPTY;
  });
  cache.set(key, pending);
  return pending;
}

/** Drop every cached preview — an install or a removal changes the files. */
export function clearIconThemePreviews(): void {
  cache.clear();
}
