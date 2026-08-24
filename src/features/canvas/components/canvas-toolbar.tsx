import {
  StickyNote,
  Type,
  Image as ImageIcon,
  Square,
  RectangleHorizontal,
  Circle,
  Diamond,
  Undo2,
  Redo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasTool } from "../stores/canvas-store";

interface ToolDef {
  tool: CanvasTool;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}

// No dedicated Select tool — the default (empty-canvas drag pans, hold Space to
// pan, click selects) is always active; create-tools auto-revert to it. Connect
// nodes by dragging between their edge handles (no tool needed).
const TOOLS: ToolDef[] = [
  { tool: "note", icon: StickyNote, label: "Note" },
  { tool: "text", icon: Type, label: "Text" },
];

/** Flowchart shapes — each drops that geometry on the next canvas click. */
const SHAPES: ToolDef[] = [
  { tool: "shape:rectangle", icon: Square, label: "Rectangle" },
  { tool: "shape:rounded", icon: RectangleHorizontal, label: "Rounded rectangle" },
  { tool: "shape:ellipse", icon: Circle, label: "Ellipse / circle" },
  { tool: "shape:diamond", icon: Diamond, label: "Diamond" },
];

/**
 * Floating Miro-style vertical tool palette. Presentational: create-logic lives
 * in the canvas panel. `note`/`text`/`connector` arm a tool (placed on next pane
 * click); media opens a file dialog immediately via `onInsertMedia`.
 */
export function CanvasToolbar({
  activeTool,
  onTool,
  onInsertMedia,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  activeTool: CanvasTool;
  onTool: (tool: CanvasTool) => void;
  onInsertMedia: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div
      className={cn(
        "absolute left-3 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-1 p-1",
        "rounded-xl border border-white/10 bg-[var(--bg-secondary)]/70 backdrop-blur-2xl shadow-[var(--shadow-overlay)]",
      )}
    >
      {TOOLS.map((t) => (
        <ToolButton
          key={t.tool}
          def={t}
          active={activeTool === t.tool}
          onClick={() => onTool(t.tool)}
        />
      ))}

      <div className="my-0.5 h-px w-5 bg-white/10" />

      {SHAPES.map((t) => (
        <ToolButton
          key={t.tool}
          def={t}
          active={activeTool === t.tool}
          onClick={() => onTool(t.tool)}
        />
      ))}

      <div className="my-0.5 h-px w-5 bg-white/10" />
      <button
        type="button"
        title="Insert image"
        onClick={onInsertMedia}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
      >
        <ImageIcon size={16} />
      </button>

      <div className="my-0.5 h-px w-5 bg-white/10" />
      <button
        type="button"
        title="Undo (⌘Z)"
        onClick={onUndo}
        disabled={!canUndo}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Undo2 size={16} />
      </button>
      <button
        type="button"
        title="Redo (⌘⇧Z)"
        onClick={onRedo}
        disabled={!canRedo}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Redo2 size={16} />
      </button>
    </div>
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
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors cursor-pointer",
        active
          ? "bg-[var(--accent-primary)]/20 text-[var(--text-primary)]"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
      )}
    >
      <def.icon size={16} />
    </button>
  );
}
