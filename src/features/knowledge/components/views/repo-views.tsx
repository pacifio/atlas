import { Copy, ExternalLink, FileText, GitBranch } from "lucide-react";
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
  Skeleton,
} from "@tryatlas/design";

/** The repo pane's top bar. No inspector toggle: the inspector only shows
 *  beside a note, so in repo mode the button did nothing. */
export function RepoTopbar({
  name,
  onCopyPath,
  onToggleSidebar,
  sidebarHidden,
}: {
  name: string;
  onCopyPath: () => void;
  onToggleSidebar?: () => void;
  sidebarHidden?: boolean;
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
      </HintGroup>
    </div>
  );
}

/** The README while it loads: a title bar and a paragraph of lines, so the
 *  column keeps its shape and a slow read never shows the last repo's text. */
export function ReadmeSkeleton() {
  return (
    <div role="status" aria-label="Loading README" className="flex flex-col gap-3">
      <Skeleton className="h-7 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="mt-3 h-5 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

/** A repo with no README, or one that is only whitespace. `onOpen` opens
 *  this repo as a project in the current window. */
export function RepoEmpty({ onOpen, onCopyPath }: { onOpen: () => void; onCopyPath: () => void }) {
  return (
    <EmptyState
      icon={FileText}
      title="This repo has no README"
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
