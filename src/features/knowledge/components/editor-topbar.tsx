import { ChevronRight, Folder, PanelRight } from "lucide-react";
import { RailGlyph } from "@/ui/animated-icon";

import { Hint } from "@/ui/tooltip";

interface EditorTopbarProps {
  /** Folder/segment trail (empty for root-level pages). */
  breadcrumbs?: string[];
  /** Trailing page name. */
  title: string;
  /** Icon emoji or null. Falls back to a doc glyph. */
  icon?: string | null;
  /** Tag pill on the right ("NOTE", "REPO" etc.). */
  kind?: string;
  /** Show a small dirty dot before the inspector toggle. */
  isDirty?: boolean;
  /** Toggle the left sidebar; the open button only shows when hidden. */
  onToggleSidebar?: () => void;
  sidebarHidden?: boolean;
  /** Toggle the right inspector panel. */
  onToggleInspector?: () => void;
}

/**
 * Compact note topbar. Just breadcrumbs + kind pill + a single
 * inspector toggle on the right — History / Pin / More were removed in
 * batch 1 of the user's feedback since none of them wire to anything.
 */
export function EditorTopbar({
  breadcrumbs = [],
  title,
  icon,
  kind = "NOTE",
  isDirty,
  onToggleSidebar,
  sidebarHidden,
  onToggleInspector,
}: EditorTopbarProps) {
  return (
    <div
      className="flex items-center shrink-0 border-b border-border-subtle"
      style={{
        height: 36,
        gap: 8,
        padding: "0 14px",
        background: "var(--panel-background)",
      }}
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
      {/* Breadcrumbs */}
      <div
        className="flex items-center min-w-0 text-sm"
        style={{ gap: 6, color: "var(--muted-foreground)" }}
      >
        {breadcrumbs.map((segment, i) => (
          <span key={i} className="flex items-center" style={{ gap: 6 }}>
            <Folder size={11} className="text-muted-foreground shrink-0" strokeWidth={1.5} />
            <span className="truncate">{segment}</span>
            <ChevronRight size={10} className="text-muted-foreground shrink-0" />
          </span>
        ))}
        <span className="flex items-center text-foreground truncate" style={{ gap: 5 }}>
          <span className="leading-none">{icon ?? "📄"}</span>
          <span className="truncate">{title}</span>
        </span>
      </div>

      <span className="pill pill-bare text-2xs" style={{ height: 18, padding: "0 6px" }}>
        {kind}
      </span>

      <span className="flex-1" />

      {isDirty && (
        <span
          className="dot"
          style={{ background: "var(--foreground)", width: 6, height: 6 }}
          title="Unsaved changes"
        />
      )}
      {onToggleInspector && (
        <Hint label="Toggle inspector">
          <button
            onClick={onToggleInspector}
            className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors"
            style={{ width: 22, height: 22 }}
          >
            <PanelRight size={12} />
          </button>
        </Hint>
      )}
    </div>
  );
}
