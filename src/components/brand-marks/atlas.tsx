import { AtlasBadge, AtlasMark } from "@tryatlas/design";
import { cn } from "@/lib/utils";

export { AtlasBadge, AtlasMark };

interface AtlasIconProps {
  size?: number;
  className?: string;
  alt?: string;
}

/**
 * The Atlas mark at a pixel size, kept so call sites only changed their
 * import. From 32px up it is the package's `AtlasBadge` in the app icon's
 * tile (black with a white mark in every theme, as `atlas-icon.svg` drew it);
 * below that a tile would be a smudge, so it is the bare `AtlasMark`
 * in the ink it sits in.
 *
 * `className` styles the frame around the mark, not the mark: a call site's
 * corner radius clips the badge (`overflow-hidden`), and its ring, shadow or
 * opacity sit on the frame, so the package primitive keeps its own look.
 */
export function AtlasIcon({ size = 32, className, alt = "Atlas" }: AtlasIconProps) {
  return (
    <span
      role="img"
      aria-label={alt}
      className={cn("inline-flex shrink-0 select-none overflow-hidden", className)}
      style={{ width: size, height: size }}
    >
      {size >= 32 ? (
        <AtlasBadge aria-hidden tone="app-icon" className="size-full [&_svg]:size-1/2" />
      ) : (
        <AtlasMark className="size-full" />
      )}
    </span>
  );
}
