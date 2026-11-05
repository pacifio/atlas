import { useEffect, useState } from "react";
import { File as FileGlyph, Folder } from "lucide-react";
import { Icon } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import {
  ICON_PREVIEW_ROW,
  loadIconThemePreview,
  type IconThemePreview as PreviewData,
  type PreviewIcon,
} from "../lib/icon-preview";
import type { IconAppearance, IconKind } from "../lib/icon-theme-api";

/**
 * One icon theme's file row, drawn without the theme being applied.
 *
 * The counterpart to `previewTheme` on the colour-theme card: the same
 * "show it, do not apply it" move, done with the commands' own `themeId`
 * argument instead of with CSS variables. `null` — a theme with nothing for
 * that path, a fetch that failed, or "Minimal", which is no theme at all —
 * draws the lucide icon the row would have had, which is what the app does.
 */

/** A theme icon's cell edge in px: the package `Icon`'s `lg` step, so a
 *  theme's icon and the lucide fallback line up. Inline rather than `size-4`,
 *  which is rem-based and would drift from it with the root font size. */
const SIZE = 16;

function Fallback({ kind }: { kind: IconKind }) {
  return (
    <Icon icon={kind === "file" ? FileGlyph : Folder} size="lg" className="text-muted-foreground" />
  );
}

function Cell({ icon, kind }: { icon: PreviewIcon; kind: IconKind }) {
  if (!icon) return <Fallback kind={kind} />;

  if (icon.kind === "glyph") {
    return (
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center justify-center leading-none"
        style={{
          width: SIZE,
          height: SIZE,
          // Quoted: an icon theme's id is a publisher-dotted name, which is
          // not a valid unquoted CSS family.
          fontFamily: icon.fontFamily ? `"${icon.fontFamily}"` : undefined,
          color: icon.color,
        }}
      >
        {icon.character}
      </span>
    );
  }

  if (icon.kind === "url") {
    return (
      <img src={icon.url} alt="" aria-hidden width={SIZE} height={SIZE} className="shrink-0" />
    );
  }

  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: SIZE, height: SIZE }}
      dangerouslySetInnerHTML={{ __html: icon.svg }}
    />
  );
}

export function IconThemePreview({
  themeId,
  appearance,
  className,
}: {
  themeId: string;
  appearance: IconAppearance;
  className?: string;
}) {
  const [preview, setPreview] = useState<PreviewData | null>(null);

  useEffect(() => {
    let alive = true;
    void loadIconThemePreview(themeId, appearance).then((next) => {
      if (alive) setPreview(next);
    });
    return () => {
      alive = false;
    };
  }, [themeId, appearance]);

  return (
    <div aria-hidden className={cn("flex items-center gap-2.5", className)}>
      {/* Only a glyph theme has any, and only once it has been resolved. */}
      {preview && preview.fontFaces.length > 0 && <style>{preview.fontFaces}</style>}
      {ICON_PREVIEW_ROW.map((entry, index) => (
        <Cell key={entry.path} icon={preview?.icons[index] ?? null} kind={entry.kind} />
      ))}
    </div>
  );
}
