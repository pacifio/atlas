import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SvgViewerView } from "./views/svg-viewer-view";

interface SvgViewerProps {
  filePath: string;
}

/**
 * `.svg` tab handler. SVG is both renderable AND source, so instead of the code
 * editor we render the image (zoom/pan via `ImageZoomView`, fed a safe
 * asset-protocol URL) and expose a "Copy code" button that copies the raw
 * markup (read as text via `read_file_content`).
 */
export function SvgViewer({ filePath }: SvgViewerProps) {
  const name = filePath.split("/").pop() ?? filePath;
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCode(null);
    invoke<string>("read_file_content", { path: filePath })
      .then((t) => !cancelled && setCode(t))
      .catch(() => !cancelled && setCode(null));
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Render from the file's actual markup (not the asset protocol, which can
  // 404/CSP-block and goes stale on rename) by inlining it as a data URL.
  const src = useMemo(
    () => (code ? `data:image/svg+xml,${encodeURIComponent(code)}` : null),
    [code],
  );

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <SvgViewerView
      filePath={filePath}
      name={name}
      src={src}
      copied={copied}
      onCopy={() => void copy()}
    />
  );
}
