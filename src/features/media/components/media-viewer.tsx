import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { classifyFile, type FileKind } from "@/lib/file-types";
import { ImageZoomView } from "./image-zoom-view";

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

  return (
    <div className="h-full w-full flex flex-col bg-[var(--bg-base)]">
      <div className="flex items-center px-3 h-[32px] border-b border-[var(--border-default)] shrink-0 text-[11px] font-mono text-[var(--text-tertiary)] truncate">
        {filePath}
      </div>
      {kind === "image" ? (
        <div className="flex-1 min-h-0">
          <ImageZoomView src={src} alt={name} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-auto">
          {kind === "video" && <video src={src} controls className="max-w-full max-h-full" />}
          {kind === "audio" && (
            <div className="flex flex-col items-center gap-3 text-[var(--text-secondary)]">
              <span className="text-[12px] font-mono">{name}</span>
              <audio src={src} controls />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
