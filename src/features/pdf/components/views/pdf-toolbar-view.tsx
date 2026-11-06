import {
  Eraser,
  Highlighter,
  MousePointer2,
  Pencil,
  StickyNote,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { HintGroup, HintItem, IconButton, Separator, Toggle } from "@tryatlas/design";
import { PDF_SWATCHES, type PdfTool } from "../../lib/pdf-annotations";

export interface PdfToolbarViewProps {
  fileName: string;
  zoom: number;
  dirty: boolean;
  tool: PdfTool;
  color: string;
  /** The `pdf.save` binding's label ("⌘S"), for the unsaved dot's title. */
  saveShortcut: string | null;
  onToolChange: (tool: PdfTool) => void;
  onColorChange: (color: string) => void;
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

/**
 * The PDF tab's toolbar: annotation tools, ink swatches, the file name with
 * its unsaved dot, and content zoom. Tools and swatches are plain toggles, one
 * Tab stop each; clicking the active one keeps it on.
 */
export function PdfToolbarView({
  fileName,
  zoom,
  dirty,
  tool,
  color,
  saveShortcut,
  onToolChange,
  onColorChange,
  onZoomIn,
  onZoomOut,
}: PdfToolbarViewProps) {
  return (
    <div
      data-view="pdf-toolbar"
      className="flex h-[36px] shrink-0 items-center gap-2 border-b border-border bg-background px-3"
    >
      <HintGroup>
        <div className="flex items-center gap-0.5">
          {TOOLS.map(({ tool: t, icon: Icon, label }) => (
            <HintItem key={t} label={label}>
              <Toggle
                size="sm"
                aria-label={label}
                pressed={tool === t}
                onPressedChange={() => onToolChange(t)}
              >
                <Icon />
              </Toggle>
            </HintItem>
          ))}
        </div>
      </HintGroup>

      <Separator orientation="vertical" strong className="h-4" />

      <HintGroup>
        <div className="flex items-center gap-0.5">
          {PDF_SWATCHES.map((s) => (
            <HintItem key={s.id} label={`Color: ${s.label}`}>
              <Toggle
                size="sm"
                aria-label={`Color: ${s.label}`}
                pressed={color === s.id}
                onPressedChange={() => onColorChange(s.id)}
              >
                <span
                  aria-hidden
                  className="size-3.5 rounded-full ring-1 ring-foreground/15 ring-inset"
                  style={{ background: s.id }}
                />
              </Toggle>
            </HintItem>
          ))}
        </div>
      </HintGroup>

      <div
        className="mx-1 flex min-w-0 flex-1 items-center justify-center gap-1.5 font-mono text-xs text-muted-foreground"
        title={fileName}
      >
        {/* Unsaved-changes dot. Annotations are saved beside the PDF, in the
            project's profile dir (`.atlas/pdf-annotations.json`, see
            `commands/pdf_annotations.rs`) — the PDF file itself is
            never modified, which is what keeps them erasable. They autosave a
            beat after each edit; the shortcut only saves now. */}
        {dirty && (
          <span
            className="inline-block size-1.5 shrink-0 rounded-full bg-foreground"
            title={`Unsaved annotations — saving shortly${saveShortcut ? `, or ${saveShortcut} to save now` : ""}. Annotations are kept with the project; the PDF file is never changed.`}
          />
        )}
        <span className="truncate">{fileName}</span>
      </div>

      {/* Content zoom only; never the WebView's interface scale (D6). At a
          bound the click is a clamped no-op, so neither button disables. */}
      <HintGroup>
        <div className="flex items-center gap-0.5">
          <HintItem label="Zoom out">
            <IconButton size="xs" icon={ZoomOut} label="Zoom out" onClick={onZoomOut} />
          </HintItem>
          <span className="w-9 text-center font-mono text-2xs text-muted-foreground tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <HintItem label="Zoom in">
            <IconButton size="xs" icon={ZoomIn} label="Zoom in" onClick={onZoomIn} />
          </HintItem>
        </div>
      </HintGroup>
    </div>
  );
}
