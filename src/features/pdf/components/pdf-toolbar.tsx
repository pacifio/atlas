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
import { HintGroup, HintItem } from "@/ui/hint-group";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
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

const COLOR_NAMES: Record<string, string> = {
  "#F5C542": "Amber",
  "#6796E6": "Blue",
  "#5CC28A": "Green",
  "#F44747": "Red",
  "#C4A5E7": "Purple",
};

export function PdfToolbar({ fileName, zoom, dirty, onZoomIn, onZoomOut }: PdfToolbarProps) {
  const tool = usePdfAnnotationStore.use.tool();
  const color = usePdfAnnotationStore.use.color();
  const saveShortcut = useActionShortcut("pdf.save");
  const { setTool, setColor } = usePdfAnnotationStore.use.actions();

  return (
    <div className="flex items-center gap-2 px-3 h-[36px] shrink-0 border-b border-[var(--border)] bg-[var(--background)]">
      {/* Tools */}
      <HintGroup>
        <div className="flex items-center gap-0.5">
          {TOOLS.map(({ tool: t, icon: Icon, label }) => (
            <HintItem key={t} label={label}>
              <button
                type="button"
                onClick={() => setTool(t)}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded transition-colors",
                  tool === t
                    ? "bg-[var(--atlas-element-selected)] text-[var(--foreground)]"
                    : "text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
                )}
              >
                <Icon size={13} />
              </button>
            </HintItem>
          ))}
        </div>
      </HintGroup>

      <div className="h-4 w-px bg-[var(--border)]" />

      {/* Colors */}
      <HintGroup>
        <div className="flex items-center gap-1">
          {PDF_COLORS.map((c) => (
            <HintItem
              key={c}
              label={COLOR_NAMES[c] ? `Color: ${COLOR_NAMES[c]}` : `Use color ${c}`}
            >
              <button
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "h-3.5 w-3.5 rounded-full border transition-transform",
                  color === c ? "border-[var(--foreground)] scale-110" : "border-black/20",
                )}
                style={{ background: c }}
              />
            </HintItem>
          ))}
        </div>
      </HintGroup>

      <div
        className="mx-1 flex flex-1 items-center justify-center gap-1.5 truncate text-xs font-mono text-[var(--muted-foreground)]"
        title={fileName}
      >
        {/* Unsaved-changes dot. Annotations are saved beside the PDF, in the
            project's profile dir (`.atlas/pdf-annotations.json`, see
            `commands/pdf_annotations.rs`) — the PDF file itself is
            never modified, which is what keeps them erasable. They autosave a
            beat after each edit; the shortcut only saves now. */}
        {dirty && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--foreground)]"
            title={`Unsaved annotations — saving shortly${saveShortcut ? `, or ${saveShortcut.label} to save now` : ""}. Annotations are kept with the project; the PDF file is never changed.`}
          />
        )}
        <span className="truncate">{fileName}</span>
      </div>

      {/* Zoom */}
      <HintGroup>
        <div className="flex items-center gap-0.5">
          <HintItem label="Zoom out">
            <button
              type="button"
              onClick={onZoomOut}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
            >
              <ZoomOut size={13} />
            </button>
          </HintItem>
          <span className="w-9 text-center text-2xs font-mono text-[var(--muted-foreground)]">
            {Math.round(zoom * 100)}%
          </span>
          <HintItem label="Zoom in">
            <button
              type="button"
              onClick={onZoomIn}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
            >
              <ZoomIn size={13} />
            </button>
          </HintItem>
        </div>
      </HintGroup>
    </div>
  );
}
