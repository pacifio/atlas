import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
// Vite `?url` import — resolves to the bundled worker asset. Must match the
// pdfjs-dist version react-pdf re-exports (pinned in package.json).
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useElementSize } from "../hooks/use-element-size";
import { usePdfAnnotationStore } from "../stores/pdf-annotation-store";
import { AnnotationLayer } from "./annotation-layer";
import { PdfToolbar } from "./pdf-toolbar";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

interface PdfViewerProps {
  filePath: string;
  tabId?: string;
}

const PAGE_PADDING = 64; // matches the scroll container's px-8 (32 each side)

export function PdfViewer({ filePath, tabId }: PdfViewerProps) {
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1); // 1 = fit-to-width
  const [saving, setSaving] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const { width: containerWidth } = useElementSize(scrollRef);

  const dirtyMap = usePdfAnnotationStore.use.dirty();
  const { load, save: saveAnnotations } = usePdfAnnotationStore.use.actions();
  const isDirty = !!dirtyMap[filePath];

  const fileName = filePath.split("/").pop() ?? filePath;

  // Load PDF bytes through our own Rust command (works for `.atlas/` paths the
  // asset protocol would 403; PDF.js also dislikes blob URLs in WKWebView).
  useEffect(() => {
    let cancelled = false;
    setFileData(null);
    setError(null);
    void invoke<string>("read_file_base64", { path: filePath })
      .then((b64) => {
        if (cancelled) return;
        setFileData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      })
      .catch((e) => {
        if (!cancelled) setError(`Failed to read PDF: ${e}`);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Load persisted (editable) annotations for this PDF.
  useEffect(() => {
    void load(filePath);
  }, [filePath, load]);

  // Reflect unsaved annotations in the tab's dirty dot.
  useEffect(() => {
    if (tabId) useLayoutStore.getState().actions.setTabDirty(tabId, isDirty);
  }, [tabId, isDirty]);

  // react-pdf wants a stable object; hand it a copy of the raw bytes (pdfjs
  // transfers the buffer to its worker, which would detach our `fileData`).
  const pdfFile = useMemo(
    () => (fileData ? { data: fileData.slice() } : null),
    [fileData],
  );

  const pageWidth = useMemo(() => {
    const fit = Math.max(320, containerWidth - PAGE_PADDING);
    return Math.round(fit * zoom);
  }, [containerWidth, zoom]);

  // Cmd/Ctrl+S — flush the editable annotations to disk now. Annotations also
  // autosave (debounced) on every edit, so this is mostly reassurance. They
  // stay editable/erasable across sessions (NOT flattened into the PDF), which
  // is why the eraser keeps working on previously-saved annotations.
  const save = useCallback(async () => {
    setSaving(true);
    try {
      await saveAnnotations(filePath);
      toast.success("Annotations saved");
    } finally {
      setSaving(false);
    }
  }, [filePath, saveAnnotations]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, saving]);

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg-base)]">
      <PdfToolbar
        fileName={fileName}
        zoom={zoom}
        dirty={isDirty || saving}
        onZoomIn={() => setZoom((z) => Math.min(3, z + 0.2))}
        onZoomOut={() => setZoom((z) => Math.max(0.5, z - 0.2))}
      />

      <div
        ref={scrollRef}
        className="flex flex-1 justify-center overflow-auto bg-[var(--bg-canvas)] p-8"
      >
        {error ? (
          <div className="mt-20 text-[12px] text-[var(--status-error)]">
            {error}
          </div>
        ) : pdfFile ? (
          <Document
            file={pdfFile}
            onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}
            onLoadError={(e) =>
              setError(e.message || "Failed to load PDF document.")
            }
            loading={<PdfSpinner label="Loading PDF" />}
            error={
              <div className="mt-20 text-[12px] text-[var(--status-error)]">
                Failed to load PDF document.
              </div>
            }
            className="flex flex-col items-center gap-4"
          >
            {Array.from({ length: numPages }, (_, i) => (
              <PdfPage
                key={i}
                pdfPath={filePath}
                pageNumber={i + 1}
                width={pageWidth}
              />
            ))}
          </Document>
        ) : (
          <PdfSpinner label="Reading file" />
        )}
      </div>
    </div>
  );
}

/** One rendered page + its annotation overlay. Measures its own rendered size
 *  so the overlay (normalized coords) maps to exact pixels. */
function PdfPage({
  pdfPath,
  pageNumber,
  width,
}: {
  pdfPath: string;
  pageNumber: number;
  width: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { width: w, height: h } = useElementSize(ref);
  return (
    <div
      ref={ref}
      className="relative bg-white shadow-lg"
      data-page-number={pageNumber}
    >
      <Page
        pageNumber={pageNumber}
        width={width}
        renderTextLayer
        renderAnnotationLayer
        loading={
          <div
            className="flex items-center justify-center bg-white"
            style={{ width, height: width * 1.29 }}
          >
            <Loader2
              size={16}
              className="animate-spin text-[var(--text-tertiary)]"
            />
          </div>
        }
      />
      {w > 0 && h > 0 && (
        <AnnotationLayer
          pdfPath={pdfPath}
          page={pageNumber}
          pageW={w}
          pageH={h}
        />
      )}
    </div>
  );
}

function PdfSpinner({ label }: { label: string }) {
  return (
    <div className="mt-20 flex flex-col items-center gap-2 text-[var(--text-tertiary)]">
      <Loader2 size={18} className="animate-spin" />
      <span className="text-[11px]">{label}</span>
    </div>
  );
}
