import {
  MousePointer2,
  Highlighter,
  Pencil,
  StickyNote,
  Eraser,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePdfAnnotationStore, PDF_COLORS, type PdfTool } from "../stores/pdf-annotation-store";

interface PdfToolbarProps {
  fileName: string;
  zoom: number;
  dirty: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

const TOOLS: Array<{ tool: PdfTool; icon: typeof Pencil; label: string }> = [
  { tool: "none", icon: MousePointer2, label: "Select / read" },
  { tool: "highlight", icon: Highlighter, label: "Highlight" },
  { tool: "pencil", icon: Pencil, label: "Draw" },
  { tool: "note", icon: StickyNote, label: "Note" },
  { tool: "erase", icon: Eraser, label: "Erase" },
];

export function PdfToolbar({ fileName, zoom, dirty, onZoomIn, onZoomOut }: PdfToolbarProps) {
  const tool = usePdfAnnotationStore.use.tool();
  const color = usePdfAnnotationStore.use.color();
  const { setTool, setColor } = usePdfAnnotationStore.use.actions();

  return (
    <div className="flex items-center gap-2 px-3 h-[36px] shrink-0 border-b border-[var(--border-default)] bg-[var(--bg-base)]">
      {/* Tools */}
      <div className="flex items-center gap-0.5">
        {TOOLS.map(({ tool: t, icon: Icon, label }) => (
          <button
            key={t}
            type="button"
            onClick={() => setTool(t)}
            title={label}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded transition-colors",
              tool === t
                ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
            )}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>

      <div className="h-4 w-px bg-[var(--border-default)]" />

      {/* Colors */}
      <div className="flex items-center gap-1">
        {PDF_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            title={c}
            className={cn(
              "h-3.5 w-3.5 rounded-full border transition-transform",
              color === c ? "border-[var(--text-primary)] scale-110" : "border-black/20",
            )}
            style={{ background: c }}
          />
        ))}
      </div>

      <div
        className="mx-1 flex flex-1 items-center justify-center gap-1.5 truncate text-[11px] font-mono text-[var(--text-tertiary)]"
        title={fileName}
      >
        {/* Unsaved-changes dot — Cmd+S bakes annotations into the PDF file. */}
        {dirty && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--text-primary)]"
            title="Unsaved annotations — ⌘S to save into the PDF"
          />
        )}
        <span className="truncate">{fileName}</span>
      </div>

      {/* Zoom */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onZoomOut}
          title="Zoom out"
          aria-label="Zoom out"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ZoomOut size={13} />
        </button>
        <span className="w-9 text-center text-[10px] font-mono text-[var(--text-tertiary)]">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={onZoomIn}
          title="Zoom in"
          aria-label="Zoom in"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <ZoomIn size={13} />
        </button>
      </div>
    </div>
  );
}
