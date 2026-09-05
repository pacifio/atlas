// The composer's "+" attach menu. Presentation only: the file dialogs,
// image-vs-path routing, GitHub clone, and session referencing all live in the
// parent (`message-input.tsx`). The session list reuses the `@` rail's
// search source so the menu and rail cannot drift.
//
// The two searchable submenus (GitHub, Sessions) embed a text <input> inside a
// Radix `SubContent` and stop keydown propagation so Radix's typeahead doesn't
// eat the keystrokes — the same pattern the workspace "+" AddProjectMenu uses.

import { useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { invoke } from "@tauri-apps/api/core";
import {
  Boxes,
  Camera,
  Check,
  ChevronRight,
  Crop,
  Download,
  FolderGit2,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  Monitor,
  Paperclip,
  Plus,
  Search,
  Star,
} from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { cn } from "@/lib/utils";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { GithubRepo, ClonedRepo } from "@/features/github/types";
import {
  searchMentions,
  listPastSessions,
  type MentionWorkspace,
  type PastSessionRef,
} from "../lib/mentions";

interface ComposerAddMenuProps {
  disabled?: boolean;
  /** Project root — scopes sessions/workspaces to this project, and is the
   *  clone destination root for GitHub repos (`<project>/.atlas/repos`). */
  projectPath: string | null;
  /** Skill-registry agent id (e.g. "claude-code" | "codex" | "cersei"). */
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
  onPickWorkspace: (workspace: MentionWorkspace) => void;
}

const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-default outline-none " +
  "text-[var(--text-secondary)] data-[highlighted]:bg-[var(--bg-hover)] " +
  "data-[highlighted]:text-[var(--text-primary)]";

const CONTENT_CLASS =
  "atlas-menu-pop rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] " +
  "shadow-[var(--shadow-overlay)] py-1";

// Shared search-box header for the searchable submenus. `stopPropagation`
// keeps Radix's menu typeahead from stealing the keystrokes.
function SearchBox({
  value,
  onChange,
  placeholder,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onEnter?: () => void;
}) {
  // NOTE: deliberately NOT auto-focused. A Radix `SubContent` opened by HOVER
  // keeps focus on its SubTrigger; programmatically focusing this input pulls
  // focus off the trigger and makes the PARENT menu's highlight jump to another
  // item (the reported glitch). Click-to-focus is the standard for a
  // hover-opened menu search box. `stopPropagation` keeps Radix's menu typeahead
  // from stealing keystrokes once the box has focus.
  return (
    <div
      className="mx-1 mb-1 flex items-center gap-1.5 rounded border border-[var(--border-default)] px-2 h-[26px]"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Search size={11} className="shrink-0 text-[var(--text-tertiary)]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter?.();
        }}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
      />
    </div>
  );
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
  onPickWorkspace,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);

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
  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          window.dispatchEvent(new CustomEvent("atlas:composer-menu-open", { detail: "add" }));
        }
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          disabled={disabled}
          className={cn(
            "flex items-center justify-center w-6.5 h-6.5 rounded-full border border-[var(--border-default)]",
            "bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors outline-none",
            disabled
              ? "opacity-50 cursor-default"
              : "hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer",
          )}
          title="Attach files, media, repos, or a past session"
        >
          <Plus size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={6}
          className={cn(CONTENT_CLASS, "min-w-[210px]")}
          style={{ zIndex: 9999 }}
        >
          <DropdownMenu.Item className={ITEM_CLASS} onSelect={onAddFilesOrPhotos}>
            <Paperclip size={11} />
            <span>{imageSupported ? "Add files or photos" : "Add files"}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM_CLASS} onSelect={onAttachMedia}>
            <ImageIcon size={11} />
            <span>Attach media</span>
          </DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={ITEM_CLASS}>
              <Camera size={11} />
              <span>Take a screenshot</span>
              <ChevronRight size={11} className="ml-auto text-[var(--text-tertiary)]" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={6}
                className={cn(CONTENT_CLASS, "min-w-[190px]")}
                style={{ zIndex: 9999 }}
              >
                <DropdownMenu.Item
                  className={ITEM_CLASS}
                  onSelect={() => onTakeScreenshot("region")}
                >
                  <Crop size={11} />
                  <span>Selected region</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={ITEM_CLASS} onSelect={() => onTakeScreenshot("full")}>
                  <Monitor size={11} />
                  <span>Whole desktop</span>
                </DropdownMenu.Item>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />

          <GithubSubmenu projectPath={projectPath} onCloneRepo={onCloneRepo} />

          <SessionsSubmenu
            projectPath={projectPath}
            agentId={agentId}
            onPickSession={onPickSession}
          />

          <WorkspaceSubmenu
            projectPath={projectPath}
            agentId={agentId}
            onPickWorkspace={onPickWorkspace}
          />

          {/* Zed-style registry entry point: opens Settings → Agents. Agent
              SWITCHING lives on the agent pill, not here — this menu is about
              what you attach to a message, and the pill's picker now offers
              one-click installs of its own (see FeaturedAgentOffers). */}
          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openSettingsSection("agents");
            }}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <Plus size={11} />
            Add more agents
          </button>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ── Add from GitHub — search remote repos, clone into `.atlas/repos` ──────────
function GithubSubmenu({
  projectPath,
  onCloneRepo,
}: {
  projectPath: string | null;
  onCloneRepo: (repo: GithubRepo) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GithubRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [cloned, setCloned] = useState<ClonedRepo[]>([]);

  // Refresh the already-cloned list whenever the submenu opens (and whenever a
  // clone completes elsewhere — same signal the GitHub panel emits).
  const loadCloned = () => {
    if (!projectPath) return;
    invoke<ClonedRepo[]>("list_cloned_repos", { projectPath })
      .then(setCloned)
      .catch(() => setCloned([]));
  };
  useEffect(() => {
    const on = () => loadCloned();
    window.addEventListener("atlas:repo-cloned", on);
    return () => window.removeEventListener("atlas:repo-cloned", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  // A searched repo is "already downloaded" when its on-disk dir (`owner-repo`)
  // is present in the cloned list — the same name we pass to `clone_github_repo`.
  const clonedDirs = useMemo(() => new Set(cloned.map((c) => c.name)), [cloned]);
  const isCloned = (repo: GithubRepo) => clonedDirs.has(repo.full_name.replace(/\//g, "-"));

  const runSearch = () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    invoke<GithubRepo[]>("search_github", { query: q })
      .then((rows) => setResults(rows))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  };

  return (
    <DropdownMenu.Sub onOpenChange={(o) => o && loadCloned()}>
      <DropdownMenu.SubTrigger className={ITEM_CLASS}>
        <GithubIcon size={11} />
        <span>Add from GitHub</span>
        <ChevronRight size={11} className="ml-auto text-[var(--text-tertiary)]" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={6}
          className={cn(CONTENT_CLASS, "w-[300px]")}
          style={{ zIndex: 9999 }}
        >
          {!projectPath ? (
            <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
              Open a project to clone repos into it.
            </div>
          ) : (
            <>
              <SearchBox
                value={query}
                onChange={setQuery}
                placeholder="Search GitHub repos…  (Enter)"
                onEnter={runSearch}
              />
              <div className="max-h-[300px] overflow-y-auto">
                {/* Already-downloaded repos — a plain, disabled list. */}
                {cloned.length > 0 && (
                  <>
                    <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wide text-[var(--text-tertiary)]">
                      Downloaded
                    </div>
                    {cloned.map((c) => (
                      <DropdownMenu.Item
                        key={c.name}
                        disabled
                        className={cn(ITEM_CLASS, "opacity-60 data-[disabled]:opacity-60")}
                        title={`Already downloaded · ${c.path}`}
                      >
                        <FolderGit2 size={11} className="shrink-0 text-[var(--text-tertiary)]" />
                        <span className="truncate">{c.display_name}</span>
                        <Check
                          size={11}
                          className="ml-auto shrink-0 text-[var(--status-success)]"
                        />
                      </DropdownMenu.Item>
                    ))}
                    <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />
                  </>
                )}

                {/* Search results. */}
                {loading ? (
                  <div className="flex items-center gap-2 px-3 h-[26px] text-[11px] text-[var(--text-tertiary)]">
                    <Loader2 size={11} className="animate-spin" />
                    Searching…
                  </div>
                ) : results === null ? (
                  <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                    Type a repo name and press Enter.
                  </div>
                ) : results.length === 0 ? (
                  <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                    No repositories found.
                  </div>
                ) : (
                  results.map((repo) => {
                    const already = isCloned(repo);
                    return (
                      <DropdownMenu.Item
                        key={repo.full_name}
                        disabled={already}
                        className={cn(
                          ITEM_CLASS,
                          "h-auto items-start py-1.5",
                          already && "opacity-60 data-[disabled]:opacity-60",
                        )}
                        onSelect={() => onCloneRepo(repo)}
                        title={repo.description || repo.full_name}
                      >
                        {already ? (
                          <Check
                            size={11}
                            className="mt-0.5 shrink-0 text-[var(--status-success)]"
                          />
                        ) : (
                          <Download
                            size={11}
                            className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[var(--text-primary)]">
                              {repo.full_name}
                            </span>
                            {already ? (
                              <span className="ml-auto shrink-0 text-[9px] text-[var(--text-tertiary)]">
                                downloaded
                              </span>
                            ) : (
                              <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[9px] text-[var(--text-tertiary)]">
                                <Star size={9} /> {repo.stars}
                              </span>
                            )}
                          </div>
                          {repo.description && (
                            <div className="text-[10px] text-[var(--text-tertiary)] line-clamp-2">
                              {repo.description}
                            </div>
                          )}
                        </div>
                      </DropdownMenu.Item>
                    );
                  })
                )}
              </div>
            </>
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

// ── Attach a session — reference a past session's transcript ──────────────────
function SessionsSubmenu({
  projectPath,
  agentId,
  onPickSession,
}: {
  projectPath: string | null;
  agentId?: string;
  onPickSession: (session: PastSessionRef) => void;
}) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<PastSessionRef[] | null>(null);

  const load = () => {
    if (sessions !== null) return;
    listPastSessions({ projectPath, agentId })
      .then((rows) => setSessions(rows))
      .catch(() => setSessions([]));
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = sessions ?? [];
    return q ? rows.filter((s) => s.title.toLowerCase().includes(q)) : rows;
  }, [sessions, query]);

  return (
    <DropdownMenu.Sub onOpenChange={(o) => o && load()}>
      <DropdownMenu.SubTrigger className={ITEM_CLASS}>
        <MessageSquareText size={11} />
        <span>Attach a session</span>
        <ChevronRight size={11} className="ml-auto text-[var(--text-tertiary)]" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={6}
          className={cn(CONTENT_CLASS, "w-[300px]")}
          style={{ zIndex: 9999 }}
        >
          {!projectPath ? (
            <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
              Open a project to browse its sessions.
            </div>
          ) : (
            <>
              <SearchBox value={query} onChange={setQuery} placeholder="Search sessions…" />
              <div className="max-h-[300px] overflow-y-auto">
                {sessions === null ? (
                  <div className="flex items-center gap-2 px-3 h-[26px] text-[11px] text-[var(--text-tertiary)]">
                    <Loader2 size={11} className="animate-spin" />
                    Loading sessions…
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                    {sessions.length === 0 ? "No past sessions in this project." : "No matches."}
                  </div>
                ) : (
                  filtered.map((s) => (
                    <DropdownMenu.Item
                      key={s.id}
                      className={cn(ITEM_CLASS, "h-auto items-start py-1.5")}
                      onSelect={() => onPickSession(s)}
                      title={s.title}
                    >
                      <MessageSquareText
                        size={11}
                        className="mt-0.5 shrink-0 text-[var(--text-tertiary)]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[var(--text-primary)]">{s.title}</div>
                        <div className="text-[10px] text-[var(--text-tertiary)]">
                          {s.messageCount} message
                          {s.messageCount === 1 ? "" : "s"}
                        </div>
                      </div>
                    </DropdownMenu.Item>
                  ))
                )}
              </div>
            </>
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

// ── Reference workspace — hand the agent another project's path ───────────────
// Mirrors `SessionsSubmenu`, but lists the OTHER workspaces in the active org
// (the same set the `@workspace` reference-picker rail surfaces). Picking one
// inserts a `@workspace` mention; at send time Rust expands it into that
// project's absolute path so an agent in p1 can be told to go inspect p3.
function WorkspaceSubmenu({
  projectPath,
  agentId,
  onPickWorkspace,
}: {
  projectPath: string | null;
  agentId?: string;
  onPickWorkspace: (workspace: MentionWorkspace) => void;
}) {
  const [query, setQuery] = useState("");
  const [workspaces, setWorkspaces] = useState<MentionWorkspace[] | null>(null);

  // `searchMentions("workspace")` reads the workspace + org stores synchronously
  // and filters to the active org, so this is effectively instant — but it stays
  // async to match the mention API and to re-run per keystroke for free.
  useEffect(() => {
    let cancelled = false;
    void searchMentions(query, "workspace", { projectPath, agentId })
      .then((rows) => {
        if (cancelled) return;
        setWorkspaces(rows.filter((m): m is MentionWorkspace => m.kind === "workspace"));
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query, projectPath, agentId]);

  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={ITEM_CLASS}>
        <Boxes size={11} />
        <span>Reference workspace</span>
        <ChevronRight size={11} className="ml-auto text-[var(--text-tertiary)]" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={6}
          className={cn(CONTENT_CLASS, "w-[300px]")}
          style={{ zIndex: 9999 }}
        >
          <SearchBox value={query} onChange={setQuery} placeholder="Search workspaces…" />
          <div className="max-h-[300px] overflow-y-auto">
            {workspaces === null ? (
              <div className="flex items-center gap-2 px-3 h-[26px] text-[11px] text-[var(--text-tertiary)]">
                <Loader2 size={11} className="animate-spin" />
                Loading workspaces…
              </div>
            ) : workspaces.length === 0 ? (
              <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                {query ? "No matches." : "No other projects in this organisation."}
              </div>
            ) : (
              workspaces.map((w) => (
                <DropdownMenu.Item
                  key={w.id}
                  className={cn(ITEM_CLASS, "h-auto items-start py-1.5")}
                  onSelect={() => onPickWorkspace(w)}
                  title={w.absPath}
                >
                  <Boxes size={11} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[var(--text-primary)]">{w.displayName}</div>
                    <div className="truncate text-[10px] text-[var(--text-tertiary)]">
                      {w.absPath}
                    </div>
                  </div>
                </DropdownMenu.Item>
              ))
            )}
          </div>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
