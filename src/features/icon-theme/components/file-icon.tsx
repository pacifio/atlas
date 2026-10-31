import { useEffect, type ComponentType } from "react";
import { File as FileGlyph, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { detectLanguage, PLAINTEXT } from "../lib/language-id";
import { useIconThemeStore } from "../stores/icon-theme-store";
import { cacheKey, type PreparedIcon } from "../stores/icon-theme-store";
import type { IconKind } from "../lib/icon-theme-api";
import { fontFaceCss, safeFontIdent } from "../lib/font-face-css";

/**
 * One file's or folder's icon, under the active icon theme.
 *
 * Everywhere a path is listed renders this: the explorer tree, the editor tab
 * strip, the file-search palette. The fallback is deliberately the exact
 * lucide icon that site drew before icon themes existed, so "Minimal"
 * (decision 12) is not a special mode — it is this component never finding an
 * answer, which is also what the first frame looks like while a resolve is in
 * flight. One code path, no flash of a different shape.
 */

/**
 * What a call site falls back to.
 *
 * Wider than `LucideIcon` on purpose: the tab strip's fallbacks include
 * `AtlasIcon`, which is an `<img>` and not a lucide glyph at all. The two
 * props every one of them takes are the two this component sets.
 */
export type FallbackIcon = ComponentType<{ size?: number; className?: string }>;

/** A font-glyph icon needs the theme's `@font-face`; see `IconThemeFonts`. */
function fontFamily(fontId: string | undefined): string | undefined {
  return fontId ? safeFontIdent(`atlas-icon-font-${fontId}`) : undefined;
}

export interface FileIconProps {
  /** The path, as the app knows it. Absolute is fine. */
  path: string;
  /** Defaults to `file`; folders pass their open/closed state. */
  kind?: IconKind;
  /** Rendered box, in px. Matches the call site's existing lucide `size`. */
  size?: number;
  className?: string;
  /** The lucide icon to draw when the theme has nothing. Defaults by `kind`. */
  fallback?: FallbackIcon;
}

function defaultFallback(kind: IconKind): FallbackIcon {
  if (kind === "folderExpanded" || kind === "rootFolderExpanded") return FolderOpen;
  if (kind === "folder" || kind === "rootFolder") return Folder;
  return FileGlyph;
}

export function FileIcon({ path, kind = "file", size = 14, className, fallback }: FileIconProps) {
  const { want } = useIconThemeStore.use.actions();
  // The editor's own language table is the language-id source (decision 4
  // requires a `languageIds` table and there is no reason for a second one).
  // `plaintext` is dropped rather than sent: it is "we could not tell", and no
  // theme keys an icon on it.
  const detected = kind === "file" ? detectLanguage(path) : PLAINTEXT;
  const languageId = detected === PLAINTEXT ? undefined : detected;
  const key = cacheKey({ path, kind, languageId });

  // Re-asking when the theme changes is what makes a switch repaint the rows
  // that are already on screen; see `generation` in the store.
  const generation = useIconThemeStore.use.generation();
  const icon = useIconThemeStore((state) => state.resolved[key]);
  const prepared = useIconThemeStore((state) =>
    icon && icon.kind === "image" ? state.prepared[icon.definition] : undefined,
  );

  // Registering the want in an effect rather than during render keeps the
  // render pure — and lets one commit's worth of rows batch into one call.
  useEffect(() => {
    want({ path, kind, languageId });
  }, [want, path, kind, languageId, generation]);

  if (icon?.kind === "glyph") {
    return (
      <span
        aria-hidden
        className={cn("inline-flex shrink-0 items-center justify-center leading-none", className)}
        style={{
          width: size,
          height: size,
          fontFamily: fontFamily(icon.fontId),
          fontSize: icon.size ? undefined : size,
          color: icon.color,
        }}
      >
        {icon.character}
      </span>
    );
  }

  if (icon?.kind === "image" && prepared) {
    return <PreparedImage prepared={prepared} size={size} className={className} />;
  }

  const Fallback = fallback ?? defaultFallback(kind);
  return <Fallback size={size} className={cn("shrink-0 text-muted-foreground", className)} />;
}

function PreparedImage({
  prepared,
  size,
  className,
}: {
  prepared: PreparedIcon;
  size: number;
  className?: string;
}) {
  if (prepared.url) {
    return (
      <img
        src={prepared.url}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className={cn("shrink-0", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
      // Sanitised in `loadAssets` before it ever reaches the cache: every
      // element is on a drawing allowlist, every `on*` handler is gone and
      // every external reference is stripped. See `lib/sanitize-svg.ts` for
      // why inlining rather than an <img> is worth that pass.
      dangerouslySetInnerHTML={{ __html: prepared.svg ?? "" }}
    />
  );
}

/**
 * The `@font-face` rules a glyph-based icon theme needs (Seti and friends).
 *
 * Mounted once, near the app root. It renders nothing until a glyph icon has
 * actually been resolved, so an SVG theme — including the bundled Material —
 * never loads a font or pays for this at all.
 */
export function IconThemeFonts() {
  const fonts = useIconThemeStore.use.fonts();
  if (fonts.length === 0) return null;
  const css = fonts
    .map((font) => fontFaceCss(`atlas-icon-font-${font.id}`, font))
    .filter(Boolean)
    .join("\n");
  if (!css) return null;
  return <style data-atlas-icon-fonts>{css}</style>;
}
