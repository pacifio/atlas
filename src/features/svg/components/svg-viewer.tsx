import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { ImageZoomView } from "@/features/media/components/image-zoom-view";
import { CopyGlyph } from "@tryatlas/design";

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
    <div className="h-full w-full flex flex-col bg-[var(--background)]">
      <div className="flex items-center gap-2 px-3 h-[32px] border-b border-[var(--border)] shrink-0">
        <span className="flex-1 min-w-0 truncate text-xs font-mono text-[var(--muted-foreground)]">
          {filePath}
        </span>
        <button
          onClick={copy}
          disabled={!code}
          title="Copy SVG source"
          className="flex items-center gap-1 px-2 h-6 rounded text-2xs cursor-pointer outline-none transition-colors text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-element-hover disabled:opacity-40 disabled:cursor-default"
        >
          <CopyGlyph copied={copied} size="sm" />
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {src ? (
          <ImageZoomView src={src} alt={name} fill checkerboard />
        ) : (
          <div className="h-full flex items-center justify-center text-[var(--muted-foreground)]">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
