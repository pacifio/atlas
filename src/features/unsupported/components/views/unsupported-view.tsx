import { FileX2, FolderOpen } from "lucide-react";
import { Button, EmptyState, Icon } from "@tryatlas/design";
import { ViewerHeaderView } from "@/components/viewer-header-view";

export interface UnsupportedViewProps {
  filePath: string;
  /** The reveal button's text ("Reveal in Finder"). */
  revealLabel: string;
  onReveal: () => void;
}

/** The tab for a file Atlas can't preview: its name, why, and a way to it. */
export function UnsupportedView({ filePath, revealLabel, onReveal }: UnsupportedViewProps) {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : null;

  return (
    <div data-view="unsupported" className="flex h-full w-full flex-col bg-background">
      <ViewerHeaderView path={filePath} />
      <EmptyState
        className="min-h-0 flex-1"
        icon={FileX2}
        title={name}
        description={
          ext
            ? `File type .${ext} not supported for inline preview.`
            : "Files without an extension can't be previewed in Atlas."
        }
        action={
          <Button size="sm" variant="secondary" onClick={onReveal}>
            <Icon icon={FolderOpen} size="sm" />
            {revealLabel}
          </Button>
        }
      />
    </div>
  );
}
