import type { FileKind } from "@/lib/file-types";
import { ViewerHeaderView } from "@/components/viewer-header-view";
import { ImageZoomView } from "../image-zoom-view";

export interface MediaViewerViewProps {
  filePath: string;
  name: string;
  kind: FileKind;
  /** A URL the webview can load the file from. */
  src: string;
}

/** An image (zoomable), a video or an audio file, under the path header. */
export function MediaViewerView({ filePath, name, kind, src }: MediaViewerViewProps) {
  return (
    <div data-view="media-viewer" className="flex h-full w-full flex-col bg-background">
      <ViewerHeaderView path={filePath} />
      {kind === "image" ? (
        <div className="min-h-0 flex-1">
          <ImageZoomView src={src} alt={name} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          {kind === "video" && <video src={src} controls className="max-h-full max-w-full" />}
          {kind === "audio" && (
            <div className="flex flex-col items-center gap-3 rounded-xl bg-card p-4 text-secondary-foreground ring-1 ring-foreground/10">
              <span className="font-mono text-xs">{name}</span>
              <audio src={src} controls />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
