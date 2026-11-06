import { useState, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { toast } from "sonner";
import { useCanvasStore } from "../stores/canvas-store";
import { exportCanvas, type ExportFormat } from "./canvas-export";

/** The package's export ids (`CANVAS_EXPORT_FORMATS`) onto the exporter's. */
const FORMAT_BY_ID: Record<string, ExportFormat> = {
  png: "png",
  jpeg: "jpeg",
  svg: "svg",
  pdf: "pdf",
};

/**
 * Export the board in `containerRef` as PNG, JPEG, SVG or PDF.
 *
 * `containerRef` is this Canvas instance's own wrapper: it scopes the export
 * to its DOM subtree, so a hidden Spaces board (or another split column's
 * Canvas tab) never gets picked up instead.
 */
export function useCanvasExport(containerRef: RefObject<HTMLElement | null>) {
  const rf = useReactFlow();
  const { setSelectedIds } = useCanvasStore.use.actions();
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setExporting(format);
    // Deselect so selection outlines / resize handles don't bleed into the image.
    setSelectedIds([]);
    // Let the deselect paint before capturing.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const container = containerRef.current;
    if (!container) {
      setExporting(null);
      return;
    }
    try {
      const res = await exportCanvas(format, rf, container);
      if (res === "ok") toast.success(`Exported ${format.toUpperCase()}`);
      else if (res === "empty") toast("Nothing to export — the canvas is empty.");
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const onExport = (id: string) => {
    const format = FORMAT_BY_ID[id];
    if (format && !exporting) void run(format);
  };

  return { exporting, onExport };
}
