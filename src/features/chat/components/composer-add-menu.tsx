// The composer's "+" attach menu: the container. It owns the open state, the
// `atlas:composer-menu-open` handshake, and the data the submenus list (cloned
// and searched GitHub repos, past sessions, the org's other projects); the
// menu itself is `views/composer-add-menu-view.tsx`. The file dialogs,
// image-vs-path routing, GitHub clone, and session referencing all live in the
// parent (`message-input.tsx`). The session list reuses the `@` rail's search
// source so the menu and rail cannot drift.
//
// Everything a submenu holds is reset each time the menu opens, as it was when
// each submenu kept its own state and unmounted with the menu: a reopened menu
// starts with an empty search and reloads its lists.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { GithubRepo, ClonedRepo } from "@/features/github/types";
import { listClonedRepos, searchGithub } from "@/features/github/lib/github-api";
import {
  searchMentions,
  listPastSessions,
  type MentionProject,
  type PastSessionRef,
} from "../lib/mentions";
import { ComposerAddMenuView } from "./views/composer-add-menu-view";

interface ComposerAddMenuProps {
  disabled?: boolean;
  /** Project root — scopes sessions/projects to this project, and is the
   *  clone destination root for GitHub repos (`<project>/.atlas/repos`). */
  projectPath: string | null;
  /** Skill-registry agent id (e.g. "claude-code" | "codex" | "atlas-agent"). */
  agentId?: string;
  /** Agent accepts inline base64 images (`promptCapabilities.image`). */
  imageSupported: boolean;
  onAddFilesOrPhotos: () => void;
  onAttachMedia: () => void;
  onTakeScreenshot: (mode: "region" | "full") => void;
  onCloneRepo: (repo: GithubRepo) => void;
  onPickSession: (session: PastSessionRef) => void;
  /** Reference another project in the active org — inserts a `@workspace`
   *  mention that hands the agent that project's path. */
  onPickProject: (project: MentionProject) => void;
}

export function ComposerAddMenu({
  disabled,
  projectPath,
  agentId,
  imageSupported,
  onAddFilesOrPhotos,
  onAttachMedia,
  onTakeScreenshot,
  onCloneRepo,
  onPickSession,
  onPickProject,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);

  // GitHub: the already-cloned list, and a search run on Enter.
  const [githubQuery, setGithubQuery] = useState("");
  const [githubResults, setGithubResults] = useState<GithubRepo[] | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [cloned, setCloned] = useState<ClonedRepo[]>([]);
  // Sessions: loaded once per open, filtered locally.
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessions, setSessions] = useState<PastSessionRef[] | null>(null);
  // Projects: searched per keystroke.
  const [projectQuery, setProjectQuery] = useState("");
  const [projects, setProjects] = useState<MentionProject[] | null>(null);
  // Bumped on every open: a GitHub search still in flight from an earlier open
  // lands in a menu that has since been reset, and is dropped (as it was when
  // the submenu unmounted with the menu).
  const openGeneration = useRef(0);

  // The composer hosts two floating menus (this + menu and the grouped
  // agent/mode/model panel). Opening either announces itself; the other
  // closes — they must never stack (see atlas:composer-menu-open).
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== "add") setOpen(false);
    };
    window.addEventListener("atlas:composer-menu-open", onOther);
    return () => window.removeEventListener("atlas:composer-menu-open", onOther);
  }, []);

  const onOpenChange = useCallback((o: boolean) => {
    setOpen(o);
    if (o) {
      openGeneration.current += 1;
      setGithubQuery("");
      setGithubResults(null);
      setGithubLoading(false);
      setCloned([]);
      setSessionQuery("");
      setSessions(null);
      setProjectQuery("");
      setProjects(null);
      window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "add" }));
    }
  }, []);

  // Refresh the already-cloned list whenever the GitHub submenu opens (and
  // whenever a clone completes elsewhere — same signal the GitHub panel emits).
  const loadCloned = useCallback(() => {
    if (!projectPath) return;
    listClonedRepos(projectPath)
      .then(setCloned)
      .catch(() => setCloned([]));
  }, [projectPath]);
  useEffect(() => {
    if (!open) return;
    const on = () => loadCloned();
    window.addEventListener("atlas:repo-cloned", on);
    return () => window.removeEventListener("atlas:repo-cloned", on);
  }, [open, loadCloned]);

  // A searched repo is "already downloaded" when its on-disk dir (`owner-repo`)
  // is present in the cloned list — the same name we pass to `clone_github_repo`.
  const clonedDirs = useMemo(() => new Set(cloned.map((c) => c.name)), [cloned]);
  const isCloned = useCallback(
    (repo: GithubRepo) => clonedDirs.has(repo.full_name.replace(/\//g, "-")),
    [clonedDirs],
  );

  const runGithubSearch = () => {
    const q = githubQuery.trim();
    if (!q) return;
    const generation = openGeneration.current;
    const current = () => generation === openGeneration.current;
    setGithubLoading(true);
    searchGithub(q)
      .then((rows) => current() && setGithubResults(rows))
      .catch(() => current() && setGithubResults([]))
      .finally(() => current() && setGithubLoading(false));
  };

  const loadSessions = () => {
    if (sessions !== null) return;
    listPastSessions({ projectPath, agentId })
      .then((rows) => setSessions(rows))
      .catch(() => setSessions([]));
  };
  const filteredSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase();
    const rows = sessions ?? [];
    return q ? rows.filter((s) => s.title.toLowerCase().includes(q)) : rows;
  }, [sessions, sessionQuery]);

  // `searchMentions("workspace")` reads the project + org stores synchronously
  // and filters to the active org, so this is effectively instant — but it stays
  // async to match the mention API and to re-run per keystroke for free.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void searchMentions(projectQuery, "workspace", { projectPath, agentId })
      .then((rows) => {
        if (cancelled) return;
        setProjects(rows.filter((m): m is MentionProject => m.kind === "workspace"));
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectQuery, projectPath, agentId]);

  return (
    <ComposerAddMenuView
      open={open}
      onOpenChange={onOpenChange}
      disabled={!!disabled}
      hasProject={!!projectPath}
      imageSupported={imageSupported}
      onAddFilesOrPhotos={onAddFilesOrPhotos}
      onAttachMedia={onAttachMedia}
      onTakeScreenshot={onTakeScreenshot}
      github={{
        query: githubQuery,
        onQuery: setGithubQuery,
        onSearch: runGithubSearch,
        loading: githubLoading,
        results: githubResults,
        cloned,
        isCloned,
        onOpen: loadCloned,
        onClone: onCloneRepo,
      }}
      sessions={{
        query: sessionQuery,
        onQuery: setSessionQuery,
        all: sessions,
        filtered: filteredSessions,
        onOpen: loadSessions,
        onPick: onPickSession,
      }}
      projects={{
        query: projectQuery,
        onQuery: setProjectQuery,
        rows: projects,
        onPick: onPickProject,
      }}
      onAddMoreAgents={() => {
        setOpen(false);
        openSettingsSection("agents");
      }}
    />
  );
}
