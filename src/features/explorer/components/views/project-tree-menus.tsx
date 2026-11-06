import { OpenInEditorContextItems } from "@/features/external-editor/components/open-in-editor-menu";
import type { WorkingTreeChanges } from "@/features/git/lib/use-working-tree-changes";
import { revealInFileManagerLabel } from "@/lib/platform";

import { absoluteOf } from "../../lib/project-file-ops";
import type { TreeRowData } from "../../lib/project-tree-model";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  KbdCombo,
} from "@tryatlas/design";

/**
 * The project file tree's context menus: a row's, and the empty space
 * below the rows. Props only; `ProjectFileTree` owns what each item does.
 */

type TreeClipboard = { paths: string[]; isCut: boolean };

export function ProjectTreeRowMenu({
  row,
  root,
  changes,
  clipboard,
  onShowDiff,
  askAgent,
  targetsFor,
  beginNewEntry,
  open,
  revealInFinder,
  terminalAt,
  openInDefaultApp,
  setClipboard,
  duplicate,
  paste,
  dirForPaste,
  copyText,
  ignore,
  setRenaming,
  setDeleteTargets,
}: {
  row: TreeRowData;
  root: string;
  changes: WorkingTreeChanges;
  clipboard: TreeClipboard | null;
  onShowDiff?: (path: string) => void;
  /** Ask the agent about these files (the row, or the selection it is in). */
  askAgent: (rows: TreeRowData[]) => void;
  targetsFor: (row: TreeRowData) => TreeRowData[];
  beginNewEntry: (parent: string, isDir: boolean) => void;
  open: (abs: string) => void;
  revealInFinder: (abs: string) => Promise<void>;
  terminalAt: (abs: string) => void;
  openInDefaultApp: (abs: string) => unknown;
  setClipboard: (clipboard: TreeClipboard) => void;
  duplicate: (abs: string) => unknown;
  paste: (destRel: string) => void;
  dirForPaste: (row: TreeRowData | null) => string;
  copyText: (text: string) => void;
  ignore: (rel: string) => void;
  setRenaming: (path: string) => void;
  setDeleteTargets: (targets: TreeRowData[]) => void;
}) {
  const abs = absoluteOf(root, row.path);
  const isDir = row.kind === "directory";
  const targets = targetsFor(row);
  const count = targets.length > 1 ? ` (${targets.length})` : "";
  // A compacted row is its innermost folder; say which, since the row
  // shows several names.
  const which = row.chain && targets.length === 1 ? ` ${row.name}` : "";
  const changed = !isDir && changes.files.has(abs);
  const askFiles = targets.filter((t) => t.kind === "file");
  return (
    <>
      {isDir ? (
        <>
          <ContextMenuItem onClick={() => beginNewEntry(row.path, false)}>New File</ContextMenuItem>
          <ContextMenuItem onClick={() => beginNewEntry(row.path, true)}>
            New Folder
          </ContextMenuItem>
        </>
      ) : (
        <>
          <ContextMenuItem onClick={() => open(abs)}>Open</ContextMenuItem>
          {changed && onShowDiff && (
            <ContextMenuItem onClick={() => onShowDiff(row.path)}>Open Changes</ContextMenuItem>
          )}
        </>
      )}
      {askFiles.length > 0 && (
        <ContextMenuItem onClick={() => askAgent(askFiles)}>
          {askFiles.length > 1
            ? `Ask Agent About These Files (${askFiles.length})`
            : "Ask Agent About This File"}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void revealInFinder(abs)}>
        {revealInFileManagerLabel}
      </ContextMenuItem>
      {isDir ? (
        <ContextMenuItem onClick={() => terminalAt(abs)}>Open in Terminal</ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => void openInDefaultApp(abs)}>
          Open in Default App
        </ContextMenuItem>
      )}
      <OpenInEditorContextItems path={abs} />
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() =>
          setClipboard({ paths: targets.map((t) => absoluteOf(root, t.path)), isCut: true })
        }
      >
        Cut{count}
        <ContextMenuShortcut>
          <KbdCombo combo="⌘X" />
        </ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          setClipboard({ paths: targets.map((t) => absoluteOf(root, t.path)), isCut: false })
        }
      >
        Copy{count}
        <ContextMenuShortcut>
          <KbdCombo combo="⌘C" />
        </ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void duplicate(abs)}>
        Duplicate
        <ContextMenuShortcut>
          <KbdCombo combo="⌘D" />
        </ContextMenuShortcut>
      </ContextMenuItem>
      {clipboard && (
        <ContextMenuItem onClick={() => paste(dirForPaste(row))}>
          Paste
          <ContextMenuShortcut>
            <KbdCombo combo="⌘V" />
          </ContextMenuShortcut>
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => copyText(targets.map((t) => absoluteOf(root, t.path)).join("\n"))}
      >
        Copy Path{count}
        <ContextMenuShortcut>
          <KbdCombo combo="⌥⌘C" />
        </ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onClick={() => copyText(targets.map((t) => t.path).join("\n"))}>
        Copy Relative Path{count}
        <ContextMenuShortcut>
          <KbdCombo combo="⇧⌥⌘C" />
        </ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      {!row.ignored && (
        <ContextMenuItem onClick={() => ignore(row.path)}>Add to .gitignore</ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => setRenaming(row.path)}>
        Rename{which}
        <ContextMenuShortcut>
          <KbdCombo combo="↵" />
        </ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onClick={() => setDeleteTargets(targets)}>
        Delete{which}
        {count}
        <ContextMenuShortcut>
          <KbdCombo combo="⌘⌫" />
        </ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

export function ProjectTreeEmptyMenu({
  root,
  clipboard,
  beginNewEntry,
  paste,
  revealInFinder,
  terminalAt,
  collapseAll,
}: {
  root: string;
  clipboard: TreeClipboard | null;
  beginNewEntry: (parent: string, isDir: boolean) => void;
  paste: (destRel: string) => void;
  revealInFinder: (abs: string) => Promise<void>;
  terminalAt: (abs: string) => void;
  collapseAll: () => void;
}) {
  return (
    <>
      <ContextMenuItem onClick={() => beginNewEntry("", false)}>New File</ContextMenuItem>
      <ContextMenuItem onClick={() => beginNewEntry("", true)}>New Folder</ContextMenuItem>
      {clipboard && <ContextMenuItem onClick={() => paste("")}>Paste</ContextMenuItem>}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void revealInFinder(root)}>
        Reveal Project in Finder
      </ContextMenuItem>
      <ContextMenuItem onClick={() => terminalAt(root)}>Open in Terminal</ContextMenuItem>
      <OpenInEditorContextItems path={root} />
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => collapseAll()}>Collapse All</ContextMenuItem>
    </>
  );
}
