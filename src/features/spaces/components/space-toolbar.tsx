import { Popover } from "@base-ui/react/popover";
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
import { createContext, useContext, useState } from "react";
import { cn } from "@/lib/utils";
import type { SpaceDock } from "../lib/dock";
import { HintGroup, HintItem, Hint } from "@tryatlas/design";

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
  const divider = horizontal
    ? "mx-0.5 h-5 w-px bg-border-subtle"
    : "my-0.5 h-px w-5 bg-border-subtle";
  const hintSide = horizontal ? null : dock === "right" ? "left" : "right";
  return (
    <HintGroup side="top">
      <DockHintSide.Provider value={hintSide}>
        <div
          className={cn(
            "absolute z-panel flex items-center gap-1 p-1",
            "rounded-xl border border-border-subtle bg-card/70 shadow-md backdrop-blur-2xl",
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
          <DockHint label="Insert image or video">
            <button
              type="button"
              onClick={onInsertMedia}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
            >
              <ImageIcon size={16} />
            </button>
          </DockHint>

          <div className={divider} />
          <DockHint label="Undo" shortcut="⌘Z">
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Undo2 size={16} />
            </button>
          </DockHint>
          <DockHint label="Redo" shortcut="⌘⇧Z">
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Redo2 size={16} />
            </button>
          </DockHint>

          <div className={divider} />
          <DockMenu dock={dock} onDock={onDock} horizontal={horizontal} />
        </div>
      </DockHintSide.Provider>
    </HintGroup>
  );
}

/** Which way a side dock's tooltips open; `null` for the bottom dock. */
const DockHintSide = createContext<"left" | "right" | null>(null);

/** The bottom dock is a row, so its controls share one sliding tooltip
 *  (`HintGroup`). A side dock is a column, which the group cannot follow, so
 *  there each control gets its own `Hint`, opening away from the edge. */
function DockHint({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: React.ReactElement<Record<string, unknown>>;
}) {
  const side = useContext(DockHintSide);
  if (side === null) {
    return <HintItem label={shortcut ? `${label} (${shortcut})` : label}>{children}</HintItem>;
  }
  return (
    <Hint label={label} shortcut={shortcut} side={side}>
      {children}
    </Hint>
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
      <DockHint label="Dock position">
        <Popover.Trigger
          render={
            <button
              type="button"
              className={cn(
                "flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors",
                open
                  ? "bg-primary/20 text-foreground"
                  : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
              )}
            >
              <Settings2 size={16} />
            </button>
          }
        />
      </DockHint>
      <Popover.Portal>
        <Popover.Positioner
          className="z-popover"
          side={horizontal ? "top" : dock === "right" ? "left" : "right"}
          align="end"
          sideOffset={8}
        >
          <Popover.Popup className="atlas-panel-in-tl inset-highlight shadow-md select-none overflow-hidden rounded-xl border border-border-subtle bg-card/95 backdrop-blur-2xl">
            <div className="flex w-[168px] flex-col py-1">
              <div className="px-3 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
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
                    "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-element-hover",
                    dock === d.dock ? "text-foreground" : "text-secondary-foreground",
                  )}
                >
                  <d.icon size={12} className="shrink-0 text-muted-foreground" />
                  {d.label}
                  {dock === d.dock && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
                  )}
                </button>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
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
    <DockHint label={def.label}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-colors",
          active
            ? "bg-primary/20 text-foreground"
            : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
        )}
      >
        <def.icon size={16} />
      </button>
    </DockHint>
  );
}
