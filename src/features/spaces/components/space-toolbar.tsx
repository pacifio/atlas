import * as Popover from "@radix-ui/react-popover";
import {
  Circle,
  Diamond,
  Frame,
  Image as ImageIcon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Redo2,
  Settings2,
  Square,
  StickyNote,
  Triangle,
  Type,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { SpaceDock } from "../lib/dock";

/** The realtime canvas's tool set — the CONTRACT's shapes (no "rounded";
 *  triangle instead), plus group. Same visual recipe as the local canvas's
 *  floating dock; presentational only. */
export type SpaceTool =
  | "select"
  | "note"
  | "text"
  | "group"
  | "shape:rectangle"
  | "shape:ellipse"
  | "shape:diamond"
  | "shape:triangle";

interface ToolDef {
  tool: SpaceTool;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}

const TOOLS: ToolDef[] = [
  { tool: "note", icon: StickyNote, label: "Note" },
  { tool: "text", icon: Type, label: "Text" },
  { tool: "group", icon: Frame, label: "Group frame" },
];

const SHAPES: ToolDef[] = [
  { tool: "shape:rectangle", icon: Square, label: "Rectangle" },
  { tool: "shape:ellipse", icon: Circle, label: "Ellipse / circle" },
  { tool: "shape:diamond", icon: Diamond, label: "Diamond" },
  { tool: "shape:triangle", icon: Triangle, label: "Triangle" },
];

export function SpaceToolbar({
  activeTool,
  onTool,
  onInsertMedia,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  disabled,
  dock,
  onDock,
}: {
  activeTool: SpaceTool;
  onTool: (tool: SpaceTool) => void;
  onInsertMedia: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  disabled?: boolean;
  dock: SpaceDock;
  onDock: (dock: SpaceDock) => void;
}) {
  // Bottom is a row; left/right are columns pinned to the middle of that edge.
  const horizontal = dock === "bottom";
  const divider = horizontal ? "mx-0.5 h-5 w-px bg-white/10" : "my-0.5 h-px w-5 bg-white/10";
  return (
    <div
      className={cn(
        "absolute z-40 flex items-center gap-1 p-1",
        "rounded-xl border border-white/10 bg-[var(--bg-secondary)]/70 shadow-[var(--shadow-overlay)] backdrop-blur-2xl",
        horizontal
          ? "bottom-3 left-1/2 -translate-x-1/2 flex-row"
          : "top-1/2 -translate-y-1/2 flex-col",
        dock === "left" && "left-3",
        dock === "right" && "right-3",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      {TOOLS.map((t) => (
        <ToolButton
          key={t.tool}
          def={t}
          active={activeTool === t.tool}
          onClick={() => onTool(activeTool === t.tool ? "select" : t.tool)}
        />
      ))}

      <div className={divider} />

      {SHAPES.map((t) => (
        <ToolButton
          key={t.tool}
          def={t}
          active={activeTool === t.tool}
          onClick={() => onTool(activeTool === t.tool ? "select" : t.tool)}
        />
      ))}

      <div className={divider} />
      <button
        type="button"
        title="Insert image or video"
        onClick={onInsertMedia}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        <ImageIcon size={16} />
      </button>

      <div className={divider} />
      <button
        type="button"
        title="Undo (⌘Z)"
        onClick={onUndo}
        disabled={!canUndo}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Undo2 size={16} />
      </button>
      <button
        type="button"
        title="Redo (⌘⇧Z)"
        onClick={onRedo}
        disabled={!canRedo}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Redo2 size={16} />
      </button>

      <div className={divider} />
      <DockMenu dock={dock} onDock={onDock} horizontal={horizontal} />
    </div>
  );
}

const DOCKS: Array<{ dock: SpaceDock; label: string; icon: typeof PanelLeft }> = [
  { dock: "left", label: "Dock left", icon: PanelLeft },
  { dock: "bottom", label: "Dock bottom", icon: PanelBottom },
  { dock: "right", label: "Dock right", icon: PanelRight },
];

/** Where this dock sits. Last in it, below the divider — a layout
 *  preference, not a drawing tool, so it does not belong among them. */
function DockMenu({
  dock,
  onDock,
  horizontal,
}: {
  dock: SpaceDock;
  onDock: (d: SpaceDock) => void;
  horizontal: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Dock position"
          className={cn(
            "flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors",
            open
              ? "bg-[var(--accent-primary)]/20 text-[var(--text-primary)]"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
          )}
        >
          <Settings2 size={16} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={horizontal ? "top" : dock === "right" ? "left" : "right"}
          align="end"
          sideOffset={8}
          style={{
            zIndex: 9999,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)",
          }}
          className="atlas-panel-in-tl select-none overflow-hidden rounded-xl border border-white/10 bg-[var(--bg-elevated)]/95 backdrop-blur-2xl"
        >
          <div className="flex w-[168px] flex-col py-1">
            <div className="px-3 pb-1 pt-1 text-[9.5px] font-semibold uppercase tracking-wider text-text-tertiary">
              Dock position
            </div>
            {DOCKS.map((d) => (
              <button
                key={d.dock}
                type="button"
                onClick={() => {
                  onDock(d.dock);
                  setOpen(false);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]",
                  dock === d.dock ? "text-text-primary" : "text-text-secondary",
                )}
              >
                <d.icon size={12} className="shrink-0 text-text-tertiary" />
                {d.label}
                {dock === d.dock && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--accent-primary)]" />
                )}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ToolButton({
  def,
  active,
  onClick,
}: {
  def: ToolDef;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={def.label}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors",
        active
          ? "bg-[var(--accent-primary)]/20 text-[var(--text-primary)]"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
      )}
    >
      <def.icon size={16} />
    </button>
  );
}
