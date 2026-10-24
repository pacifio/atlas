import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { IconButton } from "@/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { readDirectory, type ProjectEntry } from "@/features/explorer/lib/fs-api";
import {
  breadcrumbPathOf,
  type FileBreadcrumb,
  fileBreadcrumbChildren,
  fileBreadcrumbParent,
  fileBreadcrumbs,
  isHostPath,
  isListableHostFolder,
} from "../lib/file-path";

/**
 * The file view's second row: the path to the file as crumbs, under the tab
 * that names it.
 *
 * Each folder crumb walks the reader up to that folder (the file tab reveals
 * it in the tree beside the file), and the chevron after it lists the
 * folder's entries, so a sibling is one pick away. After walking up, the
 * crumbs keep the deeper trail down to the file, dimmed, so the way back is
 * one click. A host path outside the project has no contents menu: there is
 * no tree to list it in.
 *
 * The final crumb is the file's name, without its icon: the tab carries that.
 * Where no tab names the file (`identity`), the final crumb does, icon and
 * unsaved dot included.
 */
export interface FileBreadcrumbsProps {
  /** The project root, absolute; null for a file outside the project. */
  readonly root: string | null;
  readonly projectName: string;
  /** Where the reader is: the file, or a folder above it on `trail`. `""` is the project root. */
  readonly relativePath: string;
  /** The deepest path to show: the file, kept while the reader is above it. */
  readonly trail: string;
  /** Walks to a folder crumb, or back to the file at the trail's end. */
  readonly onNavigate: (path: string) => void;
  /** Opens a file picked from a folder's contents; absolute. */
  readonly onOpenFile: (absolutePath: string) => void;
  /** No tab names the file: the final crumb carries its icon and dirty dot. */
  readonly identity?: { readonly path: string; readonly dirty: boolean } | null;
}

function pathLabel(path: string, projectName: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || projectName;
}

function CrumbHint(props: { readonly label: string; readonly children: React.ReactElement }) {
  return (
    <Hint label={props.label} side="top" wrap={false}>
      {props.children}
    </Hint>
  );
}

function CurrentCrumb(props: {
  readonly crumb: FileBreadcrumb;
  readonly projectName: string;
  readonly identity: FileBreadcrumbsProps["identity"];
}) {
  return (
    <span aria-current="page" className="flex min-w-0 items-center gap-1.5">
      {props.identity && <FileIcon path={props.identity.path} size={14} className="shrink-0" />}
      <CrumbHint label={props.crumb.path || props.projectName}>
        <span className="block max-w-40 truncate rounded-sm px-0.5 font-medium text-foreground">
          {props.crumb.label}
        </span>
      </CrumbHint>
      {props.identity?.dirty && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          role="img"
          aria-label="Unsaved changes"
        />
      )}
    </span>
  );
}

function LabelCrumb(props: { readonly crumb: FileBreadcrumb }) {
  return (
    <CrumbHint label={props.crumb.path}>
      <span className="block max-w-40 truncate rounded-sm px-0.5 text-muted-foreground">
        {props.crumb.label}
      </span>
    </CrumbHint>
  );
}

function FolderCrumb(props: {
  readonly crumb: FileBreadcrumb;
  /** Below where the reader is, kept from where they came from. */
  readonly descendant: boolean;
  readonly projectName: string;
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <CrumbHint label={props.crumb.path || props.projectName}>
      <button
        type="button"
        onClick={() => props.onNavigate(props.crumb.path)}
        className={cn(
          "block max-w-40 cursor-pointer truncate rounded-sm px-0.5 text-left outline-none transition-colors duration-fast hover:bg-element-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.descendant ? "text-muted-foreground/70" : "text-muted-foreground",
        )}
      >
        {props.crumb.label}
      </button>
    </CrumbHint>
  );
}

interface Listing {
  readonly path: string;
  readonly entries: readonly ProjectEntry[] | null;
  readonly error: boolean;
}

/** One folder's entries, read when asked for; `attempt` asks again. */
function useFolderListing(root: string, path: string, attempt: number): Listing | null {
  const [listing, setListing] = useState<Listing | null>(null);
  useEffect(() => {
    let live = true;
    readDirectory(root, path).then(
      (entries) => live && setListing({ path, entries, error: false }),
      () => live && setListing({ path, entries: null, error: true }),
    );
    return () => {
      live = false;
    };
  }, [root, path, attempt]);
  return listing?.path === path ? listing : null;
}

function FolderMenuContent(props: {
  readonly root: string;
  readonly projectName: string;
  /** The crumb's folder: the menu can walk below it, never above. */
  readonly rootPath: string;
  readonly directoryPath: string;
  readonly currentFilePath: string;
  readonly onDirectoryChange: (path: string) => void;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const listing = useFolderListing(props.root, props.directoryPath, attempt);
  const children = listing?.entries
    ? fileBreadcrumbChildren(listing.entries, props.directoryPath)
    : [];
  const parentPath = fileBreadcrumbParent(props.directoryPath);
  const canGoBack =
    props.directoryPath !== props.rootPath &&
    parentPath !== null &&
    (props.rootPath === "" ||
      parentPath === props.rootPath ||
      parentPath.startsWith(`${props.rootPath}/`));

  let body: ReactNode;
  if (listing === null) {
    body = <DropdownMenuItem disabled>Loading folder…</DropdownMenuItem>;
  } else if (listing.error) {
    body = (
      <DropdownMenuItem closeOnClick={false} onClick={() => setAttempt((n) => n + 1)}>
        <RefreshCw />
        <span className="min-w-0 flex-1 truncate">Retry loading folder</span>
      </DropdownMenuItem>
    );
  } else if (children.length === 0) {
    body = <DropdownMenuItem disabled>This folder is empty.</DropdownMenuItem>;
  } else {
    body = (
      <DropdownMenuRadioGroup
        value={props.currentFilePath}
        onValueChange={(path) => props.onOpenFile(path as string)}
      >
        {children.map((entry) => {
          const row = (
            <>
              <FileIcon
                path={entry.path}
                kind={entry.kind === "directory" ? "folder" : "file"}
                size={14}
                className="shrink-0"
              />
              <span
                className={cn("min-w-0 flex-1 truncate", entry.ignored && "text-muted-foreground")}
              >
                {entry.label}
              </span>
            </>
          );
          return entry.kind === "directory" ? (
            <DropdownMenuItem
              key={entry.path}
              closeOnClick={false}
              onClick={() => props.onDirectoryChange(entry.path)}
            >
              {row}
              <ChevronRight />
            </DropdownMenuItem>
          ) : (
            <DropdownMenuRadioItem
              key={entry.path}
              value={entry.path}
              closeOnClick
              aria-current={entry.path === props.currentFilePath ? "page" : undefined}
            >
              <span className="flex min-w-0 items-center gap-2">{row}</span>
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    );
  }

  return (
    <DropdownMenuContent
      align="start"
      side="bottom"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" || !canGoBack || parentPath === null) return;
        event.preventDefault();
        event.stopPropagation();
        props.onDirectoryChange(parentPath);
      }}
    >
      {canGoBack && parentPath !== null && (
        <>
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => props.onDirectoryChange(parentPath)}
          >
            <ArrowLeft />
            <span className="truncate">Back to {pathLabel(parentPath, props.projectName)}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuGroup key={props.directoryPath}>{body}</DropdownMenuGroup>
    </DropdownMenuContent>
  );
}

/** The chevron after a folder crumb lists that folder's entries. */
function FolderContentsMenu(props: {
  readonly root: string;
  readonly projectName: string;
  readonly crumb: FileBreadcrumb;
  readonly currentFilePath: string;
  readonly onOpenFile: (absolutePath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [directoryPath, setDirectoryPath] = useState(props.crumb.path);
  // Opening another file or moving the crumb closes the menu and returns it to the crumb's folder.
  const [shownFor, setShownFor] = useState({
    crumbPath: props.crumb.path,
    currentFilePath: props.currentFilePath,
  });
  if (
    shownFor.crumbPath !== props.crumb.path ||
    shownFor.currentFilePath !== props.currentFilePath
  ) {
    setShownFor({ crumbPath: props.crumb.path, currentFilePath: props.currentFilePath });
    setOpen(false);
    setDirectoryPath(props.crumb.path);
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setDirectoryPath(props.crumb.path);
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        render={
          <IconButton
            icon={ChevronRight}
            size="xs"
            variant="ghost"
            label={`Browse ${props.crumb.label}`}
          />
        }
      />
      {open && (
        <FolderMenuContent
          root={props.root}
          projectName={props.projectName}
          rootPath={props.crumb.path}
          directoryPath={directoryPath}
          currentFilePath={props.currentFilePath}
          onDirectoryChange={setDirectoryPath}
          onOpenFile={(path) => {
            handleOpenChange(false);
            props.onOpenFile(`${props.root}/${path}`);
          }}
        />
      )}
    </DropdownMenu>
  );
}

function Separator() {
  return <ChevronRight size={14} aria-hidden className="mx-1 shrink-0 text-muted-foreground/60" />;
}

export function FileBreadcrumbs(props: FileBreadcrumbsProps) {
  const hostPath = isHostPath(props.trail);
  const breadcrumbs = fileBreadcrumbs(props.projectName, props.trail);
  const currentPath = breadcrumbPathOf(props.relativePath);
  const currentIndex = breadcrumbs.findIndex((crumb) => crumb.path === currentPath);
  const filePath = breadcrumbPathOf(props.trail);

  return (
    <nav aria-label="File path" className="flex h-full">
      <ol className="flex items-center">
        {breadcrumbs.map((crumb, index) => {
          const current = index === currentIndex;
          const last = index === breadcrumbs.length - 1;
          let label: ReactNode;
          if (current) {
            label = (
              <CurrentCrumb
                crumb={crumb}
                projectName={props.projectName}
                identity={last ? props.identity : null}
              />
            );
          } else if (hostPath && !last && !isListableHostFolder(crumb.path)) {
            label = <LabelCrumb crumb={crumb} />;
          } else {
            label = (
              <FolderCrumb
                crumb={crumb}
                descendant={index > currentIndex}
                projectName={props.projectName}
                onNavigate={props.onNavigate}
              />
            );
          }
          return (
            <li
              key={crumb.path || "project"}
              className="flex min-w-0 shrink-0 items-center"
              data-file-crumb
              data-current-file-crumb={current}
            >
              {label}
              {last ? null : hostPath || props.root === null ? (
                <Separator />
              ) : (
                <FolderContentsMenu
                  root={props.root}
                  projectName={props.projectName}
                  crumb={crumb}
                  currentFilePath={filePath}
                  onOpenFile={props.onOpenFile}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The crumbs in a row that scrolls sideways when it is too narrow, with its
 * scrollbar hidden and a fade on the edge that has more. Each time the path
 * or the trail changes, the deepest crumb is brought into view when it fits,
 * and the current one always.
 */
/**
 * Show the deepest crumb when it fits, but never at the cost of the current
 * one. Scrolls the row alone: `scrollIntoView` would scroll every scrollable
 * ancestor too, the panes around the file among them.
 */
function revealCrumbs(row: HTMLElement) {
  row.scrollLeft = row.scrollWidth - row.clientWidth;
  const current = row.querySelector<HTMLElement>("[data-current-file-crumb='true']");
  if (!current) return;
  const box = row.getBoundingClientRect();
  const at = current.getBoundingClientRect();
  if (at.left < box.left) row.scrollLeft += at.left - box.left;
  else if (at.right > box.right) row.scrollLeft += at.right - box.right;
}

export function FileBreadcrumbsRow(props: FileBreadcrumbsProps & { readonly className?: string }) {
  const { className, ...crumbs } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  // When the row resizes (a narrower column, a pane toggling), the current
  // crumb is brought back too; a scroll the reader made is left alone.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const measure = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((cur) => (cur.start === start && cur.end === end ? cur : { start, end }));
    };
    const resized = () => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        revealCrumbs(el);
      }
      measure();
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(resized);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    if (ref.current) revealCrumbs(ref.current);
  }, [props.relativePath, props.trail]);

  return (
    <div
      ref={ref}
      data-file-breadcrumbs
      className={cn(
        "hide-scrollbar h-full min-w-0 overflow-x-auto overflow-y-hidden",
        edges.start && edges.end
          ? "mask-x-from-90%"
          : edges.start
            ? "mask-l-from-90%"
            : edges.end
              ? "mask-r-from-90%"
              : null,
        className,
      )}
    >
      <div className="flex h-full w-max items-center text-xs">
        <FileBreadcrumbs {...crumbs} />
      </div>
    </div>
  );
}
