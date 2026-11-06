import { useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
// Vite `?url` import — resolves to the bundled worker asset. Must match the
// pdfjs-dist version react-pdf re-exports (pinned in package.json).
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { FileWarning } from "lucide-react";
import { EmptyState, Spinner } from "@tryatlas/design";
import { useElementSize } from "../../hooks/use-element-size";
import type { PdfAnnotation, PdfTool } from "../../lib/pdf-annotations";
import { AnnotationLayerView } from "./annotation-layer-view";
import { PdfToolbarView } from "./pdf-toolbar-view";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface PdfViewerViewProps {
  fileName: string;
  /** The PDF's bytes, or null while they are being read. */
  fileData: Uint8Array | null;
  error: string | null;
  zoom: number;
  dirty: boolean;
  saveShortcut: string | null;
  tool: PdfTool;
  color: string;
  /** Every annotation on this PDF; the view hands each page its own. */
  annotations: PdfAnnotation[];
  selectedId: string | null;
  onLoadError: (message: string) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToolChange: (tool: PdfTool) => void;
  onColorChange: (color: string) => void;
  onAdd: (annotation: PdfAnnotation) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string | null) => void;
  onNoteTextChange: (id: string, text: string) => void;
}

const PAGE_PADDING = 64; // matches the scroll container's px-8 (32 each side)

type PageAnnotationProps = Pick<
  PdfViewerViewProps,
  "tool" | "color" | "selectedId" | "onAdd" | "onRemove" | "onSelect" | "onNoteTextChange"
>;

/**
 * The PDF tab, from props: the toolbar, then every page of the document on
 * the panel background with its annotation overlay. Loading the bytes, the
 * annotation store and Cmd+S live in the `PdfViewer` container.
 */
export function PdfViewerView({
  fileName,
  fileData,
  error,
  zoom,
  dirty,
  saveShortcut,
  tool,
  color,
  annotations,
  selectedId,
  onLoadError,
  onZoomIn,
  onZoomOut,
  onToolChange,
  onColorChange,
  onAdd,
  onRemove,
  onSelect,
  onNoteTextChange,
}: PdfViewerViewProps) {
  const [numPages, setNumPages] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width: containerWidth } = useElementSize(scrollRef);

  // react-pdf wants a stable object; hand it a copy of the raw bytes (pdfjs
  // transfers the buffer to its worker, which would detach our `fileData`).
  const pdfFile = useMemo(() => (fileData ? { data: fileData.slice() } : null), [fileData]);

  const pageWidth = useMemo(() => {
    const fit = Math.max(320, containerWidth - PAGE_PADDING);
    return Math.round(fit * zoom);
  }, [containerWidth, zoom]);

  const pageProps: PageAnnotationProps = {
    tool,
    color,
    selectedId,
    onAdd,
    onRemove,
    onSelect,
    onNoteTextChange,
  };

  return (
    <div data-view="pdf-viewer" className="flex h-full w-full flex-col bg-background">
      <PdfToolbarView
        fileName={fileName}
        zoom={zoom}
        dirty={dirty}
        tool={tool}
        color={color}
        saveShortcut={saveShortcut}
        onToolChange={onToolChange}
        onColorChange={onColorChange}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
      />

      <div ref={scrollRef} className="flex flex-1 justify-center overflow-auto bg-panel p-8">
        {error ? (
          <EmptyState icon={FileWarning} title={error} />
        ) : pdfFile ? (
          <Document
            file={pdfFile}
            onLoadSuccess={(pdf) => setNumPages(pdf.numPages)}
            onLoadError={(e) => onLoadError(e.message || "Failed to load PDF document.")}
            loading={<PdfSpinner label="Loading PDF" />}
            error={<EmptyState icon={FileWarning} title="Failed to load PDF document." />}
            className="flex flex-col items-center gap-4"
          >
            {Array.from({ length: numPages }, (_, i) => (
              <PdfPage
                key={i}
                pageNumber={i + 1}
                width={pageWidth}
                annotations={annotations.filter((a) => a.page === i + 1)}
                {...pageProps}
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
  pageNumber,
  width,
  annotations,
  ...annotationProps
}: PageAnnotationProps & {
  pageNumber: number;
  width: number;
  annotations: PdfAnnotation[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { width: w, height: h } = useElementSize(ref);
  return (
    // A PDF page is paper, and paper is white. Decision 3 names PDF page
    // content as one of the two documented exceptions to "the theme is applied
    // everywhere" — the chrome around the page follows the theme, the page
    // itself renders the document as its author saved it.
    // ratchet-allow: decision 3 — a PDF page is paper, and paper is white.
    <div ref={ref} className="relative bg-white shadow-lg" data-page-number={pageNumber}>
      <Page
        pageNumber={pageNumber}
        width={width}
        renderTextLayer
        renderAnnotationLayer
        loading={
          <div
            // ratchet-allow: decision 3 — the placeholder for the page above.
            className="flex items-center justify-center bg-white"
            style={{ width, height: width * 1.29 }}
          >
            <Spinner size="md" label="" />
          </div>
        }
      />
      {w > 0 && h > 0 && (
        <AnnotationLayerView
          page={pageNumber}
          pageW={w}
          pageH={h}
          annotations={annotations}
          {...annotationProps}
        />
      )}
    </div>
  );
}

function PdfSpinner({ label }: { label: string }) {
  return (
    <div className="mt-20 flex flex-col items-center gap-2 text-muted-foreground">
      <Spinner size="md" label="" />
      <span className="text-xs">{label}</span>
    </div>
  );
}
