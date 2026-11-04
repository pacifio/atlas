import { CanvasToolbar, SPACES_TOOL_GROUPS } from "@tryatlas/design";
import type { SpaceDock } from "../lib/dock";

/** The realtime canvas's tool set — the CONTRACT's shapes (no "rounded";
 *  triangle instead), plus group. */
export type SpaceTool =
  | "select"
  | "note"
  | "text"
  | "group"
  | "shape:rectangle"
  | "shape:ellipse"
  | "shape:diamond"
  | "shape:triangle";

/** This dock's own names where the package preset words them differently. */
const LABELS: Record<string, string> = {
  frame: "Group frame",
  "shape:ellipse": "Ellipse / circle",
};

const TOOL_GROUPS = SPACES_TOOL_GROUPS.map((group) =>
  group.map((t) => (LABELS[t.id] ? { ...t, label: LABELS[t.id]! } : t)),
);

/** The wire's `group` is the package's `frame`; `select` is no armed tool. */
function toPackage(tool: SpaceTool): string | null {
  if (tool === "select") return null;
  return tool === "group" ? "frame" : tool;
}

function fromPackage(id: string | null): SpaceTool {
  if (id === null) return "select";
  if (id === "frame") return "group";
  return id.startsWith("shape:") || id === "note" || id === "text" ? (id as SpaceTool) : "select";
}

/** The floating tool dock, docked left, bottom or right. Presentational: the
 *  canvas decides what an armed tool does. Clicking the armed tool disarms it. */
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
  return (
    <CanvasToolbar
      groups={TOOL_GROUPS}
      activeTool={toPackage(activeTool)}
      onTool={(id) => onTool(fromPackage(id))}
      onAction={(id) => {
        if (id === "media") onInsertMedia();
      }}
      history={{ canUndo, canRedo, onUndo, onRedo }}
      dock={dock}
      onDock={onDock}
      disabled={disabled}
    />
  );
}
