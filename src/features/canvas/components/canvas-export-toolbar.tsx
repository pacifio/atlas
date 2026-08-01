import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  Download,
  Loader2,
  FileImage,
  FileType2,
  FileText,
} from "lucide-react";
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
export function CanvasExportToolbar() {
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
    try {
      const res = await exportCanvas(format, rf);
      if (res === "ok") toast.success(`Exported ${format.toUpperCase()}`);
      else if (res === "empty")
        toast("Nothing to export — the canvas is empty.");
    } catch (e) {
      toast.error(
        `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="absolute right-3 top-3 z-40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!!busy}
        title="Export canvas"
        className={cn(
          "flex items-center gap-1.5 rounded-xl border border-white/10 bg-[var(--bg-secondary)]/70 backdrop-blur-2xl px-2.5 h-8 shadow-[var(--shadow-overlay)]",
          "text-[11px] font-medium text-text-secondary hover:text-text-primary transition-colors cursor-pointer disabled:opacity-60",
        )}
      >
        {busy ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Download size={13} />
        )}
        Export
      </button>

      {open && !busy && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-full z-50 mt-1 w-[140px] overflow-hidden rounded-lg border border-border-default bg-[var(--bg-elevated)] py-1 shadow-[var(--shadow-overlay)]">
            {FORMATS.map((f) => (
              <button
                key={f.format}
                type="button"
                onClick={() => void run(f.format)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
              >
                <f.icon size={13} className="shrink-0 text-text-tertiary" />
                {f.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
