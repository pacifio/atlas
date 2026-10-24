// Where the session runs, how to open it, and the project's scripts — the
// Workspace group.
//
// First row: the environment. A machine glyph and a folder glyph, then the
// machine's name (`m4-pro`); the folder's tooltip is the project path. Every
// Atlas session runs on this machine, so it states that rather than offering
// a choice of machine or run mode.
//
// Second row: "Open in <editor>" as a split. The main action opens the
// project in the preferred editor (Settings ▸ Preferred editor; "Automatic"
// is the first one detected), the ▾ lists every other detected editor, then
// the file manager, a terminal and the clipboard. With no editor detected
// the main action is the file manager.
//
// Third: the project's scripts (`ProjectScriptsControl`).

import { useQuery } from "@tanstack/react-query";
import { Copy, Folder, FolderOpen, Laptop, SquareTerminal } from "lucide-react";

import { EditorIcon } from "@/features/external-editor/components/editor-icons";
import { OpenInEditorDropdownItems } from "@/features/external-editor/components/open-in-editor-menu";
import { SYSTEM_EDITOR_ID } from "@/features/external-editor/lib/external-editor-api";
import {
  openInEditor,
  openInLabel,
  usePreferredEditor,
} from "@/features/external-editor/lib/preferred-editor";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { isMac, isWindows } from "@/lib/platform";
import { DropdownMenuItem } from "@/ui/dropdown-menu";
import { Hint } from "@/ui/tooltip";

import { sessionEnvironment } from "../lib/session-context-api";
import { copyProjectPath, openProjectInTerminal, revealProject } from "../lib/workspace-actions";
import { ContextRow, ContextSection, ContextSplitRow, RowIcon, RowLabel } from "./context-rows";
import { ProjectScriptsControl } from "./project-scripts-control";

const FILE_MANAGER = isMac ? "Finder" : isWindows ? "Explorer" : "file manager";

function useSessionEnvironment() {
  return useQuery({
    queryKey: ["session-context", "environment"],
    queryFn: sessionEnvironment,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}

export function WorkspaceSection({
  projectPath,
  workPath = projectPath,
}: {
  projectPath: string;
  /** Where the session works (`sessionWorkPath`): a pull request session's
   *  worktree, else the project. What opens, and where scripts run. */
  workPath?: string;
}) {
  const name = useProjectStore((s) => s.projects.find((p) => p.path === projectPath)?.name ?? null);
  const folder = name ?? projectPath.split(/[\\/]/).pop() ?? projectPath;
  const environment = useSessionEnvironment();
  const { preferred } = usePreferredEditor();
  // The system default is the file manager's wording for a folder.
  const editor = preferred && preferred.id !== SYSTEM_EDITOR_ID ? preferred : null;

  return (
    <ContextSection title="Workspace" showHeading={false} separated={false}>
      <ContextRow title={`${environment?.name || "This device"} · ${workPath}`}>
        <span className="flex shrink-0 items-center gap-1">
          <RowIcon icon={Laptop} />
          <Hint label={workPath}>
            <span className="inline-flex" tabIndex={0} aria-label={`Project folder ${workPath}`}>
              <RowIcon icon={Folder} />
            </span>
          </Hint>
        </span>
        <RowLabel>{environment?.name || folder}</RowLabel>
      </ContextRow>
      <ContextSplitRow
        onClick={() => void (editor ? openInEditor(editor.id, workPath) : revealProject(workPath))}
        menuLabel="Other ways to open the project"
        menu={
          <>
            <OpenInEditorDropdownItems path={workPath} separatorAfter />
            <DropdownMenuItem onClick={() => void revealProject(workPath)}>
              <FolderOpen />
              Reveal in {FILE_MANAGER}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openProjectInTerminal(workPath)}>
              <SquareTerminal />
              Open in Terminal
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copyProjectPath(workPath)}>
              <Copy />
              Copy path
            </DropdownMenuItem>
          </>
        }
      >
        {editor ? <EditorIcon id={editor.id} /> : <RowIcon icon={FolderOpen} />}
        <RowLabel>{editor ? openInLabel(editor) : `Open in ${FILE_MANAGER}`}</RowLabel>
      </ContextSplitRow>
      <ProjectScriptsControl projectPath={projectPath} cwd={workPath} />
    </ContextSection>
  );
}
