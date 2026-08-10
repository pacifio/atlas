// The composer's "+" attach menu. Presentation only: the file dialogs,
// image-vs-path routing, GitHub clone, and session referencing all live in the
// parent (`message-input.tsx`). Skill/session lists reuse the `#`/`@` rails'
// search sources so the menu and rails cannot drift.
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
  Github,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  Monitor,
  Paperclip,
  Plus,
  Search,
  SquareSlash,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentIcons } from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";
import { SWITCHABLE_AGENTS, AGENT_LABEL, type SwitchableAgent } from "@/types/agent";
import type { GithubRepo, ClonedRepo } from "@/features/github/types";
import {
  searchMentions,
  listPastSessions,
  type MentionSkill,
  type MentionWorkspace,
  type PastSessionRef,
} from "../lib/mentions";

interface ComposerAddMenuProps {
  disabled?: boolean;
  /** Project root — scopes skills/sessions to this project, and is the clone
   *  destination root for GitHub repos (`<project>/.atlas/repos`). */
  projectPath: string | null;
  /** Skill-registry agent id (e.g. "claude-code" | "codex" | "cersei"). */
  agentId?: string;
  /** Agent accepts inline base64 images (`promptCapabilities.image`). */
  imageSupported: boolean;
  onAddFilesOrPhotos: () => void;
  onAttachMedia: () => void;
  onTakeScreenshot: (mode: "region" | "full") => void;
  onPickSkill: (skill: MentionSkill) => void;
  onCloneRepo: (repo: GithubRepo) => void;
  onPickSession: (session: PastSessionRef) => void;
  /** Reference another project in the active org — inserts a `@workspace`
   *  mention that hands the agent that project's path. */
  onPickWorkspace: (workspace: MentionWorkspace) => void;
  /** The chat's current coding agent (footer switcher highlights it). */
  currentAgent: SwitchableAgent;
  /** Switch the chat to a specific coding agent (mirrors the ⌥/ cycle). */
  onSwitchAgent: (agent: SwitchableAgent) => void;
}

const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-default outline-none " +
  "text-[var(--text-secondary)] data-[highlighted]:bg-[var(--bg-hover)] " +
  "data-[highlighted]:text-[var(--text-primary)]";

const CONTENT_CLASS =
  "rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] " +
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
  onPickSkill,
  onCloneRepo,
  onPickSession,
  onPickWorkspace,
  currentAgent,
  onSwitchAgent,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  // null = not loaded yet (spinner on first open); [] = loaded, none found.
  const [skills, setSkills] = useState<MentionSkill[] | null>(null);
  const [skillsError, setSkillsError] = useState(false);

  // Lazy-load skills the first time the menu opens.
  useEffect(() => {
    if (!open || skills !== null) return;
    let cancelled = false;
    searchMentions("", "skill", { projectPath, agentId })
      .then((found) => {
        if (cancelled) return;
        setSkills(found.filter((m): m is MentionSkill => m.kind === "skill"));
      })
      .catch(() => {
        if (cancelled) return;
        setSkills([]);
        setSkillsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, skills, projectPath, agentId]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
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
          title="Attach files, media, repos, skills, or a past session"
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

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={ITEM_CLASS}>
              <SquareSlash size={11} />
              <span>Skills</span>
              <ChevronRight size={11} className="ml-auto text-[var(--text-tertiary)]" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={6}
                className={cn(
                  CONTENT_CLASS,
                  "min-w-[220px] max-w-[280px] max-h-[320px] overflow-y-auto",
                )}
                style={{ zIndex: 9999 }}
              >
                {skills === null ? (
                  <div className="flex items-center gap-2 px-3 h-[26px] text-[11px] text-[var(--text-tertiary)]">
                    <Loader2 size={11} className="animate-spin" />
                    Loading skills…
                  </div>
                ) : skills.length === 0 ? (
                  <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                    {skillsError ? "Couldn't load skills." : "No skills installed"}
                  </div>
                ) : (
                  skills.map((skill) => (
                    <DropdownMenu.Item
                      key={skill.id}
                      className={cn(ITEM_CLASS, "h-auto items-start py-1.5")}
                      onSelect={() => onPickSkill(skill)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[var(--text-primary)]">
                            {skill.displayName}
                          </span>
                          {skill.scope === "project" && (
                            <span className="shrink-0 rounded px-1 text-[9px] leading-4 border border-[var(--border-default)] text-[var(--text-tertiary)]">
                              project
                            </span>
                          )}
                        </div>
                        {skill.description && (
                          <div className="text-[10px] text-[var(--text-tertiary)] line-clamp-2">
                            {skill.description}
                          </div>
                        )}
                      </div>
                    </DropdownMenu.Item>
                  ))
                )}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

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

          {/* Footer — agent switcher: circular brand icons on the left, the ⌥/
              cycle shortcut on the right. Plain buttons (not menu items) so a
              switch doesn't feel like "picking" an attachment; we close the
              menu ourselves after switching. */}
          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />
          <div className="flex items-center justify-between px-2 py-0.5">
            <div className="flex items-center gap-1">
              {SWITCHABLE_AGENTS.map((a) => {
                const active = a === currentAgent;
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => {
                      if (!active) onSwitchAgent(a);
                      setOpen(false);
                    }}
                    title={`Switch to ${AGENT_LABEL[a]}`}
                    className={cn(
                      "flex items-center justify-center h-5 w-5 rounded-full border border-[var(--border-default)] transition-colors outline-none cursor-pointer",
                      active
                        ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                        : "text-[var(--text-tertiary)] opacity-45 hover:opacity-100 hover:bg-[var(--bg-hover)]",
                    )}
                  >
                    {a === "claude-code" ? (
                      <AgentIcons.Claude className="size-3" />
                    ) : a === "codex" ? (
                      <AgentIcons.Codex className="size-3" />
                    ) : a === "opencode" ? (
                      <AgentIcons.OpenCode className="size-3" />
                    ) : a === "cursor" ? (
                      <AgentIcons.Cursor className="size-3" />
                    ) : a === "kilo" ? (
                      <AgentIcons.Kilo className="size-3" />
                    ) : (
                      <AtlasIcon size={12} className="rounded-[2px]" />
                    )}
                  </button>
                );
              })}
            </div>
            <span
              className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)]"
              title="Cycle coding agent"
            >
              <kbd className="rounded border border-[var(--border-default)] bg-[var(--bg-elevated)] px-1 leading-[15px] font-sans">
                ⌥
              </kbd>
              <kbd className="rounded border border-[var(--border-default)] bg-[var(--bg-elevated)] px-1 leading-[15px] font-sans">
                /
              </kbd>
            </span>
          </div>
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
        <Github size={11} />
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
                          {s.messageCount} message{s.messageCount === 1 ? "" : "s"}
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
