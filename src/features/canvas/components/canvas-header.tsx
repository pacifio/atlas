import { Crosshair, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_PAGE_ICON } from "./pages-panel";
import { RailGlyph, HintGroup, HintItem } from "@tryatlas/design";

/**
 * Floating top-left board header (replaces the old fixed bar). Glassmorphic pill
 * with the pages toggle + active page emoji/name + quick actions (fit, fullscreen).
 */
export function CanvasHeader({
  pageName,
  pageIcon,
  pagesOpen,
  onTogglePages,
  fullscreen,
  onFit,
  onToggleFullscreen,
}: {
  pageName: string;
  pageIcon?: string | null;
  pagesOpen: boolean;
  onTogglePages: () => void;
  fullscreen: boolean;
  onFit: () => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <HintGroup>
      <div
        className={cn(
          "absolute left-3 top-3 z-panel flex items-center gap-1.5 pl-1 pr-1 py-1",
          "rounded-xl border border-border-subtle bg-[var(--card)]/70 backdrop-blur-2xl shadow-md",
        )}
      >
        <HintItem label={pagesOpen ? "Hide pages" : "Show pages"}>
          <button
            type="button"
            onClick={onTogglePages}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md transition-colors cursor-pointer",
              pagesOpen
                ? "bg-element-selected text-foreground"
                : "text-muted-foreground hover:bg-element-hover hover:text-foreground",
            )}
          >
            <RailGlyph open={pagesOpen} size="md" />
          </button>
        </HintItem>
        <div className="mx-0.5 h-4 w-px bg-border-subtle" />
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-sm leading-none">
          {pageIcon || DEFAULT_PAGE_ICON}
        </span>
        <span className="max-w-[180px] truncate text-sm font-semibold text-foreground">
          {pageName || "Spaces"}
        </span>
        <div className="mx-0.5 h-4 w-px bg-border-subtle" />
        <HintItem label="Fit to view">
          <button
            type="button"
            onClick={onFit}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer"
          >
            <Crosshair size={12} />
          </button>
        </HintItem>
        <HintItem label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer"
          >
            {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </HintItem>
      </div>
    </HintGroup>
  );
}
