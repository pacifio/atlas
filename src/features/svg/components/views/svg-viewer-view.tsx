import { Button, CopyGlyph, Spinner } from "@tryatlas/design";
import { ViewerHeaderView } from "@/components/viewer-header-view";
import { ImageZoomView } from "@/features/media/components/image-zoom-view";

export interface SvgViewerViewProps {
  filePath: string;
  name: string;
  /** A data URL of the file's markup, or null while it is being read. */
  src: string | null;
  copied: boolean;
  onCopy: () => void;
}

/**
 * An SVG is both a picture and source: the picture, zoomable on a neutral
 * checkerboard (so a black `currentColor` drawing stays visible), and a
 * "Copy code" action for the markup.
 */
export function SvgViewerView({ filePath, name, src, copied, onCopy }: SvgViewerViewProps) {
  return (
    <div data-view="svg-viewer" className="flex h-full w-full flex-col bg-background">
      <ViewerHeaderView
        path={filePath}
        actions={
          <Button
            size="xs"
            variant="ghost"
            onClick={onCopy}
            disabled={!src}
            title="Copy SVG source"
          >
            <CopyGlyph copied={copied} size="xs" />
            {copied ? "Copied" : "Copy code"}
          </Button>
        }
      />
      <div className="min-h-0 flex-1">
        {src ? (
          <ImageZoomView src={src} alt={name} fill checkerboard />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner size="md" />
          </div>
        )}
      </div>
    </div>
  );
}
