import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/features/app/stores/app-store";
import { documentFileRoot } from "@/lib/file-links";
import { parseNotebook } from "../lib/notebook-types";
import { NotebookViewerView, type LoadState } from "./views/notebook-viewer-view";

interface NotebookViewerProps {
  filePath: string;
}

/**
 * `.ipynb` tab handler: reads the file and hands the parsed notebook to the
 * view. Not a Jupyter client — nothing here executes; it's a viewer for the
 * notebook as saved.
 */
export function NotebookViewer({ filePath }: NotebookViewerProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  const fileRoot = documentFileRoot(filePath, projectPath);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    invoke<string>("read_file_content", { path: filePath })
      .then((text) => {
        if (!cancelled) setState({ status: "ready", notebook: parseNotebook(text) });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return <NotebookViewerView filePath={filePath} state={state} fileRoot={fileRoot} />;
}
