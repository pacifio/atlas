import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { classifyFile, type FileKind } from "@/lib/file-types";
import { MediaViewerView } from "./views/media-viewer-view";

interface MediaViewerProps {
  filePath: string;
}

/**
 * Image / video / audio tab handler. Loads the local file via
 * `convertFileSrc` (Tauri's safe local-file URL) and renders the appropriate
 * HTML element with object-fit/contain to keep aspect ratio. The Tauri
 * asset protocol must allow the file's directory via `fs.allow` capabilities
 * — `read_file_content` already proves the directory is readable; for media
 * the same path is fetched directly by the webview, not through invoke.
 *
 * The asset URL is keyed only by path, so the webview serves a stale image
 * after a file at the same path is deleted and recreated. We append the file's
 * mtime as a cache-buster and refresh it when the window regains focus (the
 * usual moment a replacement was just saved from another app).
 */
export function MediaViewer({ filePath }: MediaViewerProps) {
  const kind: FileKind = classifyFile(filePath);
  const name = filePath.split("/").pop() ?? filePath;

  const [mtime, setMtime] = useState(0);
  const refreshMtime = useCallback(() => {
    invoke<number>("file_mtime_ms", { path: filePath })
      .then((v) => setMtime(v))
      .catch(() => {});
  }, [filePath]);

  useEffect(() => {
    refreshMtime();
    window.addEventListener("atlas:window-active", refreshMtime);
    return () => window.removeEventListener("atlas:window-active", refreshMtime);
  }, [refreshMtime]);

  const src = useMemo(() => {
    const base = convertFileSrc(filePath);
    return mtime ? `${base}${base.includes("?") ? "&" : "?"}v=${mtime}` : base;
  }, [filePath, mtime]);

  return <MediaViewerView filePath={filePath} name={name} kind={kind} src={src} />;
}
