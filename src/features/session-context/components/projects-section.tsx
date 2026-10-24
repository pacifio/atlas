// The folders this session works in — the Projects group.
//
// First the main project (where the session runs), labelled as such. Then
// each project attached to the session (`ThreadRow.attachedProjects`), in the
// order it was attached: its name, its current branch and uncommitted counts
// when it is a git repository, an access badge (eye: read only; pencil: read
// and write) that flips the access on click, and a ⋯ menu to open, reveal,
// change access or detach it. How it came to be attached is the row's title.
//
// "Attach project" lists the organisation's other projects, then offers a
// folder from disk. The backend validates either with the same rules as an
// @-mention (`validate_project_path`): its refusal is shown as it words it.
//
// An ACP agent takes a change to an open session's folders only when the
// session is next resumed; the native agent from its next turn. When a change
// waits for a resume, the section says so under the rows, in the composer
// toast's words.

import { useEffect, useMemo, useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import {
  Ellipsis,
  Eye,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Info,
  Pencil,
  Plus,
  Unlink,
} from "lucide-react";

import { EditorIcon } from "@/features/external-editor/components/editor-icons";
import { SYSTEM_EDITOR_ID } from "@/features/external-editor/lib/external-editor-api";
import {
  openInEditor,
  openInLabel,
  usePreferredEditor,
} from "@/features/external-editor/lib/preferred-editor";
import { useAttachedProjects } from "@/features/chat/hooks/use-session-roots";
import {
  attachProjectToSession,
  changeProjectAccess,
  detachProjectFromSession,
  RESUME_HINT,
} from "@/features/chat/hooks/use-session-projects";
import type { AttachedProject, AttachSource } from "@/features/chat/lib/history-api";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { useProjectGitStore } from "@/features/projects/stores/project-git-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { basename } from "@/lib/paths";
import { isMac, isWindows } from "@/lib/platform";
import { timeAgo } from "@/lib/time-ago";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";

import { revealProject } from "../lib/workspace-actions";
import { ContextRow, ContextSection, MenuButton, RowIcon, RowLabel, RowMeta } from "./context-rows";

const FILE_MANAGER = isMac ? "Finder" : isWindows ? "Explorer" : "file manager";

const SOURCE_LABEL: Record<AttachSource, string> = {
  mention: "Attached by an @-mention",
  agent_request: "Attached when you approved the agent's request",
  clone: "Attached when it was cloned from the composer",
};

/** The row's title: where it is, and how and when it was attached. */
export function attachedTitle(project: AttachedProject): string {
  const when = timeAgo(project.attachedAt, { suffix: true });
  return `${project.path}\n${SOURCE_LABEL[project.source]}${when ? ` · ${when}` : ""}`;
}

export function ProjectsSection({ tabId, projectPath }: { tabId: string; projectPath: string }) {
  const sessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? null);
  const attached = useAttachedProjects(sessionId);
  const mainName = useProjectStore(
    (s) => s.projects.find((p) => p.path === projectPath)?.name ?? null,
  );
  // A change that waits for the session's resume: said once, under the rows,
  // until the card closes.
  const [resumeOnly, setResumeOnly] = useState(false);
  const noteResume = (r: { resumeOnly: boolean }) => {
    if (r.resumeOnly) setResumeOnly(true);
  };

  return (
    <ContextSection title="Projects">
      <ContextRow title={projectPath}>
        <RowIcon icon={Folder} />
        <RowLabel>{mainName ?? basename(projectPath)}</RowLabel>
        <RowMeta>Main</RowMeta>
      </ContextRow>
      {sessionId &&
        attached.map((project) => (
          <AttachedProjectRow
            key={project.path}
            sessionId={sessionId}
            project={project}
            onChanged={noteResume}
          />
        ))}
      {sessionId ? (
        <AttachProjectPicker
          sessionId={sessionId}
          mainPath={projectPath}
          attached={attached}
          onAttached={noteResume}
        />
      ) : (
        <ContextRow
          onClick={() => {}}
          disabled
          title="Projects can be attached once the session has connected to its agent."
          className="text-muted-foreground"
        >
          <Plus size={14} className="shrink-0" aria-hidden />
          <RowLabel>Attach project</RowLabel>
        </ContextRow>
      )}
      {resumeOnly && (
        <p className="flex items-start gap-2 px-2.5 py-1 text-2xs text-muted-foreground">
          <Info size={12} className="mt-px shrink-0" aria-hidden />
          <span>{RESUME_HINT}</span>
        </p>
      )}
    </ContextSection>
  );
}

function AttachedProjectRow({
  sessionId,
  project,
  onChanged,
}: {
  sessionId: string;
  project: AttachedProject;
  onChanged: (r: { resumeOnly: boolean }) => void;
}) {
  const ensure = useProjectGitStore.use.actions().ensure;
  useEffect(() => ensure(project.path), [ensure, project.path]);
  const git = useProjectGitStore((s) => s.summaries[project.path]);
  const writable = project.access === "read_write";
  const toggleAccess = () =>
    void changeProjectAccess(sessionId, project.path, writable ? "read_only" : "read_write").then(
      onChanged,
    );
  const accessLabel = writable
    ? "Read and write · click to make read-only"
    : "Read only · click to allow writes";

  return (
    <ContextRow title={attachedTitle(project)} className="pe-1 hover:bg-element-hover">
      <RowIcon icon={git?.isRepo ? FolderGit2 : Folder} />
      <RowLabel>{project.displayName}</RowLabel>
      {git?.isRepo && (
        <RowMeta className="flex min-w-0 max-w-32 items-center gap-1.5">
          <span className="min-w-0 truncate">{git.branch}</span>
          {git.dirty && (git.additions > 0 || git.deletions > 0) && (
            <span className="shrink-0 font-mono">
              <span className="text-success">+{git.additions}</span>{" "}
              <span className="text-error">−{git.deletions}</span>
            </span>
          )}
        </RowMeta>
      )}
      <Hint label={accessLabel}>
        <IconButton
          size="xs"
          icon={writable ? Pencil : Eye}
          label={accessLabel}
          aria-pressed={writable}
          onClick={toggleAccess}
        />
      </Hint>
      <AttachedProjectMenu
        sessionId={sessionId}
        project={project}
        onToggleAccess={toggleAccess}
        onChanged={onChanged}
      />
    </ContextRow>
  );
}

function AttachedProjectMenu({
  sessionId,
  project,
  onToggleAccess,
  onChanged,
}: {
  sessionId: string;
  project: AttachedProject;
  onToggleAccess: () => void;
  onChanged: (r: { resumeOnly: boolean }) => void;
}) {
  const { preferred } = usePreferredEditor();
  const editor = preferred && preferred.id !== SYSTEM_EDITOR_ID ? preferred : null;
  const writable = project.access === "read_write";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton icon={Ellipsis} size="xs" label={`More actions for ${project.displayName}`} />
        }
      />
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          onClick={() =>
            void (editor ? openInEditor(editor.id, project.path) : revealProject(project.path))
          }
        >
          {editor ? <EditorIcon id={editor.id} /> : <FolderOpen />}
          {editor ? openInLabel(editor) : "Open in editor"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void revealProject(project.path)}>
          <FolderOpen />
          Reveal in {FILE_MANAGER}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onToggleAccess}>
          {writable ? <Eye /> : <Pencil />}
          {writable ? "Make read-only" : "Allow writes"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => void detachProjectFromSession(sessionId, project.path).then(onChanged)}
        >
          <Unlink />
          Detach from session
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Attach project": the organisation's other projects, then a folder from
 *  disk. The main project and those already attached are left out. */
function AttachProjectPicker({
  sessionId,
  mainPath,
  attached,
  onAttached,
}: {
  sessionId: string;
  mainPath: string;
  attached: readonly AttachedProject[];
  onAttached: (r: { resumeOnly: boolean }) => void;
}) {
  const projects = useActiveOrgProjects();
  const candidates = useMemo(() => {
    const taken = new Set([mainPath, ...attached.map((p) => p.path)]);
    return projects.filter((p) => !taken.has(p.path)).sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, mainPath, attached]);

  const attach = (path: string, name?: string) =>
    void attachProjectToSession(sessionId, path, name).then(onAttached);
  const browse = async () => {
    const picked = await pickFolder({ directory: true, multiple: false }).catch(() => null);
    if (typeof picked === "string" && picked) attach(picked);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <MenuButton kind="row" aria-label="Attach a project to this session">
            <Plus size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            <RowLabel>Attach project</RowLabel>
          </MenuButton>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-auto">
        {candidates.length > 0 && (
          <>
            <DropdownMenuLabel>Projects</DropdownMenuLabel>
            {candidates.map((p) => (
              <DropdownMenuItem key={p.id} title={p.path} onClick={() => attach(p.path, p.name)}>
                <Folder />
                <span className="min-w-0 truncate">{p.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => void browse()}>
          <FolderPlus />
          Choose a folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
