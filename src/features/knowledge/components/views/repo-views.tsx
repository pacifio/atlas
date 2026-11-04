import { cn } from "@/lib/utils";
import { Copy, ExternalLink, GitBranch, PanelRight } from "lucide-react";
import { RailGlyph, Hint, HintGroup, HintItem } from "@tryatlas/design";

export function RepoTopbar({
  name,
  path,
  onToggleSidebar,
  sidebarHidden,
  onToggleInspector,
}: {
  name: string;
  path: string;
  onToggleSidebar?: () => void;
  sidebarHidden?: boolean;
  onToggleInspector: () => void;
}) {
  return (
    <div
      className="flex items-center shrink-0 border-b border-border-subtle"
      style={{ height: 36, gap: 8, padding: "0 14px", background: "var(--panel-background)" }}
    >
      {onToggleSidebar && (
        <Hint label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}>
          <button
            onClick={onToggleSidebar}
            className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors"
            style={{ width: 22, height: 22, marginLeft: -6 }}
          >
            <RailGlyph open={!sidebarHidden} size="sm" />
          </button>
        </Hint>
      )}
      <GitBranch size={12} className="text-muted-foreground shrink-0" />
      <span className="font-mono text-secondary-foreground truncate flex-1 min-w-0 text-sm">
        {name}
      </span>
      <span className="pill pill-bare text-2xs" style={{ height: 18, padding: "0 6px" }}>
        REPO
      </span>
      <HintGroup>
        <HintItem label="Copy path">
          <button
            onClick={() => navigator.clipboard.writeText(path)}
            className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors cursor-pointer"
            style={{ width: 22, height: 22 }}
          >
            <Copy size={11} />
          </button>
        </HintItem>
        <HintItem label="Toggle inspector">
          <button
            onClick={onToggleInspector}
            className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors"
            style={{ width: 22, height: 22 }}
          >
            <PanelRight size={12} />
          </button>
        </HintItem>
      </HintGroup>
    </div>
  );
}

/** `onOpen` opens this repo as a project in the current window (Atlas is
 *  single-window now — was: spawn a new native window). */
export function RepoEmpty({ path, onOpen }: { path: string; onOpen: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <p className="text-sm">No README.md found</p>
      <div className="flex items-center gap-2">
        <button
          onClick={onOpen}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded border border-border",
            "text-2xs text-secondary-foreground hover:bg-element-hover cursor-pointer",
          )}
        >
          <ExternalLink size={10} /> Open as project
        </button>
        <button
          onClick={() => navigator.clipboard.writeText(path)}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded border border-border",
            "text-2xs text-secondary-foreground hover:bg-element-hover cursor-pointer",
          )}
        >
          <Copy size={10} /> Copy path
        </button>
      </div>
    </div>
  );
}
