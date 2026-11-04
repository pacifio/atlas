import { useState, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { Download, Loader2, FileImage, FileType2, FileText } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "../stores/canvas-store";
import { exportCanvas, type ExportFormat } from "../lib/canvas-export";

const FORMATS: Array<{
  format: ExportFormat;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}> = [
  { format: "png", label: "PNG", icon: FileImage },
  { format: "jpeg", label: "JPEG", icon: FileImage },
  { format: "svg", label: "SVG", icon: FileType2 },
  { format: "pdf", label: "PDF", icon: FileText },
];

/** Floating top-right export toolbar — download the canvas as PNG/JPEG/SVG/PDF. */
export function CanvasExportToolbar({
  containerRef,
}: {
  /** This Canvas instance's own wrapper — scopes the export to its DOM
   * subtree so a hidden Spaces board (or another split column's Canvas
   * tab) never gets picked up instead. */
  containerRef: RefObject<HTMLElement | null>;
}) {
  const rf = useReactFlow();
  const { setSelectedIds } = useCanvasStore.use.actions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setOpen(false);
    setBusy(format);
    // Deselect so selection outlines / resize handles don't bleed into the image.
    setSelectedIds([]);
    // Let the deselect paint before capturing.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const container = containerRef.current;
    if (!container) {
      setBusy(null);
      return;
    }
    try {
      const res = await exportCanvas(format, rf, container);
      if (res === "ok") toast.success(`Exported ${format.toUpperCase()}`);
      else if (res === "empty") toast("Nothing to export — the canvas is empty.");
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="absolute right-3 top-3 z-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!!busy}
        title="Export canvas"
        className={cn(
          "flex items-center gap-1.5 rounded-xl border border-border-subtle bg-card/70 backdrop-blur-2xl px-2.5 h-8 shadow-md",
          "text-xs font-medium text-secondary-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-60",
        )}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
        Export
      </button>

      {open && !busy && (
        <>
          <div className="fixed inset-0 z-panel" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full z-popover mt-1 w-[140px] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-md">
            {FORMATS.map((f) => (
              <button
                key={f.format}
                type="button"
                onClick={() => void run(f.format)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer"
              >
                <f.icon size={13} className="shrink-0 text-muted-foreground" />
                {f.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
