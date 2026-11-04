import { useCallback, useEffect, useState } from "react";
import { matchesAction } from "@/features/keybindings/lib/use-scoped-hotkeys";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { usePdfAnnotationStore } from "../stores/pdf-annotation-store";
import type { PdfAnnotation } from "../lib/pdf-annotations";
import { PdfViewerView } from "./views/pdf-viewer-view";

interface PdfViewerProps {
  filePath: string;
  tabId?: string;
}

const NO_ANNOTATIONS: PdfAnnotation[] = [];

export function PdfViewer({ filePath, tabId }: PdfViewerProps) {
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1); // 1 = fit-to-width
  const [saving, setSaving] = useState(false);

  const dirtyMap = usePdfAnnotationStore.use.dirty();
  const tool = usePdfAnnotationStore.use.tool();
  const color = usePdfAnnotationStore.use.color();
  const selectedId = usePdfAnnotationStore.use.selectedId();
  const annotations = usePdfAnnotationStore.use.byPath()[filePath] ?? NO_ANNOTATIONS;
  const {
    load,
    save: saveAnnotations,
    setTool,
    setColor,
    add,
    remove,
    select,
    updateNoteText,
  } = usePdfAnnotationStore.use.actions();
  const saveShortcut = useActionShortcut("pdf.save");
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
      if (matchesAction(e, "pdf.save")) {
        e.preventDefault();
        if (!saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, saving]);

  return (
    <PdfViewerView
      fileName={fileName}
      fileData={fileData}
      error={error}
      zoom={zoom}
      dirty={isDirty || saving}
      saveShortcut={saveShortcut?.label ?? null}
      tool={tool}
      color={color}
      annotations={annotations}
      selectedId={selectedId}
      onLoadError={setError}
      onZoomIn={() => setZoom((z) => Math.min(3, z + 0.2))}
      onZoomOut={() => setZoom((z) => Math.max(0.5, z - 0.2))}
      onToolChange={setTool}
      onColorChange={setColor}
      onAdd={(a) => add(filePath, a)}
      onRemove={(id) => remove(filePath, id)}
      onSelect={select}
      onNoteTextChange={(id, text) => updateNoteText(filePath, id, text)}
    />
  );
}
