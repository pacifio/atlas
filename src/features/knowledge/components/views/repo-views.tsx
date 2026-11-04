import { Copy, ExternalLink, FileText, GitBranch, PanelRight } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  Hint,
  HintGroup,
  HintItem,
  Icon,
  IconButton,
  RailGlyph,
} from "@tryatlas/design";

export function RepoTopbar({
  name,
  onCopyPath,
  onToggleSidebar,
  sidebarHidden,
  onToggleInspector,
}: {
  name: string;
  onCopyPath: () => void;
  onToggleSidebar?: () => void;
  sidebarHidden?: boolean;
  onToggleInspector: () => void;
}) {
  return (
    <div
      data-view="repo-topbar"
      className="flex h-[36px] shrink-0 items-center gap-2 border-b border-border-subtle bg-panel px-3.5"
    >
      {onToggleSidebar && (
        <Hint label={sidebarHidden ? "Show sidebar" : "Hide sidebar"}>
          <button
            type="button"
            onClick={onToggleSidebar}
            className="-ml-1.5 inline-flex size-control-sm items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-element-hover hover:text-secondary-foreground"
          >
            <RailGlyph open={!sidebarHidden} size="sm" />
          </button>
        </Hint>
      )}
      <Icon icon={GitBranch} size="sm" className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-secondary-foreground">
        {name}
      </span>
      <Badge variant="outline" size="md">
        REPO
      </Badge>
      <HintGroup>
        <HintItem label="Copy path">
          <IconButton icon={Copy} label="Copy path" size="sm" onClick={onCopyPath} />
        </HintItem>
        <HintItem label="Toggle inspector">
          <IconButton
            icon={PanelRight}
            label="Toggle inspector"
            size="sm"
            onClick={onToggleInspector}
          />
        </HintItem>
      </HintGroup>
    </div>
  );
}

/** `onOpen` opens this repo as a project in the current window (Atlas is
 *  single-window now — was: spawn a new native window). */
export function RepoEmpty({ onOpen, onCopyPath }: { onOpen: () => void; onCopyPath: () => void }) {
  return (
    <EmptyState
      icon={FileText}
      title="No README.md found"
      className="h-full"
      action={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOpen}>
            <Icon icon={ExternalLink} size="xs" /> Open as project
          </Button>
          <Button variant="outline" size="sm" onClick={onCopyPath}>
            <Icon icon={Copy} size="xs" /> Copy path
          </Button>
        </div>
      }
    />
  );
}
