import { memo, type CSSProperties } from "react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  MessageSquare,
  Map,
  Globe,
  Loader2,
  Code,
  Brain,
  BrainCircuit,
  Network,
  Terminal,
  GitCompare,
  GitBranch,
  FileDiff,
  GitCommitHorizontal,
  X,
  CheckSquare,
  ScrollText,
  FileText,
  Gauge,
  Layers,
  Frame,
  NotebookText,
  MessagesSquare,
  FolderTree,
  GitPullRequest,
  GitPullRequestArrow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { AtlasIcon } from "@/components/atlas-icon";
import { FileIcon, type FallbackIcon } from "@/features/icon-theme/components/file-icon";
import type { TabType } from "@/lib/constants";
import { groupOf, useLayoutStore, type Tab } from "../stores/layout-store";

// Typed as the icon-theme fallback rather than `React.ElementType`: these are
// what a tab falls back to when the icon theme has nothing for it, and
// `ElementType` also admits raw tag names, which a fallback cannot be.
export const tabIcons: Record<TabType, FallbackIcon> = {
  chat: AtlasIcon,
  canvas: Map,
  browser: Globe,
  tasks: CheckSquare,
  editor: Code,
  files: FolderTree,
  knowledge: Brain,
  "knowledge-graph": Network,
  memory: BrainCircuit,
  terminal: Terminal,
  diff: GitCompare,
  commit: GitCommitHorizontal,
  "pull-request": GitPullRequestArrow,
  "pull-requests": GitPullRequest,
  "session-pull-requests": GitPullRequest,
  "session-changes": FileDiff,
  "source-control": GitBranch,
  log: ScrollText,
  media: Code,
  svg: Code,
  pdf: FileText,
  notebook: NotebookText,
  unsupported: Code,
  usage: Gauge,
  artifacts: Layers,
  "comms-draft": FileText,
  spaces: Frame,
  "team-chat": MessagesSquare,
};

/** What a sortable strip hands its tab: the node dnd-kit measures, the
 *  pointer listener that starts a drag, and where the tab is mid-drag. */
interface TabDrag {
  setNodeRef: (node: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
  transform: string | undefined;
  transition: string | undefined;
  dragging: boolean;
}

interface PaneTabProps {
  tab: Tab;
  /** Overrides the tab type's icon (the projectless strip's Home). */
  icon?: FallbackIcon;
  active: boolean;
  focused: boolean;
  running: boolean;
  /** Called with the tab's id. Pass a stable function: a sortable tab is
   *  memoized on its props. */
  onSelect: (id: string) => void;
  /** Whether the tab has the right-click menu (close, close others, copy
   *  path). The projectless strip's pseudo-tabs have none. */
  menu?: boolean;
}

/**
 * One tab in a column header. A small rounded chip, not a
 * full-height cell between rules: the strip reads as a row of things you can
 * pick rather than as more chrome.
 *
 * Closing lives where the icon is: on hover a closable tab's icon becomes its
 * ×, so the close target is always in the same place and never pushes the
 * label around. Middle-click closes too, and the right-click menu closes this
 * tab, the others, the ones to its right or all of them (each through
 * `requestCloseTab`, so unsaved files and running sessions still ask), and
 * copies a file tab's path.
 *
 * Every tab stays until it is closed: there is no italic preview tab that the
 * next click replaces. The one tab another replaces is Files: a file picked
 * from it takes its place (`file-dock.tsx`), and every file after that adds
 * its own tab, or focuses the tab it already has.
 */
export function PaneTab({
  tab,
  icon,
  active,
  focused,
  running,
  onSelect,
  menu,
  drag,
}: PaneTabProps & { drag?: TabDrag }) {
  const Icon = icon ?? tabIcons[tab.type as TabType] ?? MessageSquare;
  // A tab opened from a path carries it in `data.filePath`, so the strip
  // shows the same icon the tree row it came from does.
  const filePath = typeof tab.data?.filePath === "string" ? tab.data.filePath : null;
  const close = () => requestCloseTab(tab.id);
  const style: CSSProperties | undefined = drag
    ? { transform: drag.transform, transition: drag.transition }
    : undefined;

  const chip = (
    <div
      ref={drag?.setNodeRef}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={filePath ?? undefined}
      data-tab-id={tab.id}
      data-active-tab={active || undefined}
      {...drag?.listeners}
      style={style}
      onClick={() => onSelect(tab.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(tab.id);
      }}
      // Middle-click must not paste the primary selection on Linux, nor
      // start an autoscroll elsewhere.
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && tab.closable) {
          e.preventDefault();
          close();
        }
      }}
      className={cn(
        "group/tab flex h-6 max-w-44 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md pr-2 pl-1 text-xs outline-none transition-colors",
        active
          ? focused
            ? "bg-element-selected text-foreground"
            : "bg-element-hover text-secondary-foreground"
          : "text-muted-foreground hover:bg-element-hover hover:text-foreground",
        // The tab being dragged rides over its neighbours as they make room.
        drag?.dragging && "relative z-10 bg-element-selected text-foreground",
      )}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <span
          className={cn(
            "flex items-center justify-center",
            tab.closable && "group-hover/tab:invisible",
          )}
        >
          {running ? (
            <Loader2 size={14} className="animate-spin text-primary" />
          ) : filePath ? (
            <FileIcon path={filePath} size={14} fallback={Icon} />
          ) : (
            <Icon size={14} />
          )}
        </span>
        {tab.closable && (
          // No tooltip: an × on the tab you are pointing at is not ambiguous.
          <button
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            className="absolute inset-0 hidden items-center justify-center rounded-sm text-muted-foreground hover:bg-element-active hover:text-foreground group-hover/tab:flex"
          >
            <X size={12} />
          </button>
        )}
      </span>
      <span className={cn("truncate", tab.dirty && "italic")}>{tab.title}</span>
    </div>
  );

  if (!menu) return chip;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={chip} />
      <ContextMenuContent className="min-w-44">
        <PaneTabMenuItems tab={tab} filePath={filePath} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The right-click menu's items. Mounted only while the menu is open, so it is
 * the one place that reads the whole column: a tab itself depends on nothing
 * but its own props, which is what lets the strip skip it on every render
 * that is not about it.
 */
function PaneTabMenuItems({ tab, filePath }: { tab: Tab; filePath: string | null }) {
  const tabs = useLayoutStore.use.tabs();
  const group = groupOf(tab);
  const strip = tabs.filter((t) => groupOf(t) === group);
  const closable = strip.filter((t) => t.closable);
  const index = strip.findIndex((t) => t.id === tab.id);
  const others = closable.filter((t) => t.id !== tab.id);
  const toRight = strip.slice(index + 1).filter((t) => t.closable);
  const close = () => requestCloseTab(tab.id);
  const closeAll = (list: readonly Tab[]) => {
    for (const t of list) requestCloseTab(t.id);
  };
  return (
    <>
      <ContextMenuItem disabled={!tab.closable} onClick={close}>
        Close
      </ContextMenuItem>
      <ContextMenuItem disabled={others.length === 0} onClick={() => closeAll(others)}>
        Close others
      </ContextMenuItem>
      <ContextMenuItem disabled={toRight.length === 0} onClick={() => closeAll(toRight)}>
        Close to the right
      </ContextMenuItem>
      <ContextMenuItem disabled={closable.length === 0} onClick={() => closeAll(closable)}>
        Close all
      </ContextMenuItem>
      {filePath && !filePath.startsWith("untitled:") && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void copyText(filePath)}>Copy path</ContextMenuItem>
        </>
      )}
    </>
  );
}

/**
 * A tab in a sortable strip. It owns its own sortable state and is memoized
 * on its own values, so a render of the strip skips every tab whose tab,
 * active or running state did not change. During a drag dnd-kit re-renders
 * the tabs through its context; that is the only extra work a drag costs.
 */
export const SortablePaneTab = memo(function SortablePaneTab(props: PaneTabProps) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: props.tab.id,
  });
  return (
    <PaneTab
      {...props}
      drag={{
        setNodeRef,
        listeners,
        transform: CSS.Translate.toString(transform) ?? undefined,
        transition: transition ?? undefined,
        dragging: isDragging,
      }}
    />
  );
});
