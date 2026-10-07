// The composer's "+" attach menu. Presentation only: the file dialogs,
// image-vs-path routing, GitHub clone, and session referencing all live in the
// parent (`message-input.tsx`). The session list reuses the `@` rail's
// search source so the menu and rail cannot drift.
//
// The two searchable submenus (GitHub, Sessions) embed a text <input> inside a
// Radix `SubContent` and stop keydown propagation so Radix's typeahead doesn't
// eat the keystrokes — the same pattern the project "+" AddProjectMenu uses.

import { useEffect, useMemo, useState } from "react";
import { PlusMinusGlyph } from "@/ui/animated-icon";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
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
import { Hint } from "@/ui/tooltip";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { GithubRepo, ClonedRepo } from "@/features/github/types";
import {
  searchMentions,
  listPastSessions,
  type MentionProject,
  type PastSessionRef,
} from "../lib/mentions";

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

const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-xs cursor-default outline-none " +
  "text-[var(--secondary-foreground)] data-[highlighted]:bg-[var(--atlas-element-hover)] " +
  "data-[highlighted]:text-[var(--foreground)]";

const CONTENT_CLASS =
  "atlas-menu-pop rounded-md border border-[var(--border)] bg-[var(--card)] " + "shadow-md py-1";

// Shared search-box header for the searchable submenus. `stopPropagation`
// keeps the menu's typeahead from stealing the keystrokes (Escape excepted).
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
  // hover-opened menu search box. `stopPropagation` keeps the menu's typeahead
  // from stealing keystrokes once the box has focus — every key EXCEPT Escape:
  // Base UI listens for Escape in the bubble phase (Radix used capture), so
  // swallowing it here left the submenu impossible to dismiss from the box.
  return (
    <div
      className="mx-1 mb-1 flex items-center gap-1.5 rounded border border-[var(--border)] px-2 h-[26px]"
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      <Search size={11} className="shrink-0 text-[var(--muted-foreground)]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter?.();
        }}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
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
  onPickProject,
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
      {/* `wrap`: the Trigger has no `disabled` prop for Hint to detect, but its button does. */}
      <Hint label="Attach files, media, repos, or a past session" side="top" wrap>
        <DropdownMenu.Trigger
          render={
            <button
              disabled={disabled}
              className={cn(
                "flex items-center justify-center w-6.5 h-6.5 rounded-full border border-[var(--border)]",
                "bg-[var(--card)] text-[var(--secondary-foreground)] transition-colors outline-none",
                disabled
                  ? "opacity-50 cursor-default"
                  : "hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer",
              )}
            >
              <PlusMinusGlyph open={open} size="md" />
            </button>
          }
        />
      </Hint>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" align="start" side="top" sideOffset={6}>
          <DropdownMenu.Popup className={cn(CONTENT_CLASS, "min-w-[210px]")}>
            <DropdownMenu.Item className={ITEM_CLASS} onClick={onAddFilesOrPhotos}>
              <Paperclip size={11} />
              <span>{imageSupported ? "Add files or photos" : "Add files"}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={ITEM_CLASS} onClick={onAttachMedia}>
              <ImageIcon size={11} />
              <span>Attach media</span>
            </DropdownMenu.Item>
            <DropdownMenu.SubmenuRoot>
              <DropdownMenu.SubmenuTrigger className={ITEM_CLASS}>
                <Camera size={11} />
                <span>Take a screenshot</span>
                <ChevronRight size={11} className="ml-auto text-[var(--muted-foreground)]" />
              </DropdownMenu.SubmenuTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Positioner
                  className="z-popover"
                  side="right"
                  align="start"
                  sideOffset={6}
                >
                  <DropdownMenu.Popup className={cn(CONTENT_CLASS, "min-w-[190px]")}>
                    <DropdownMenu.Item
                      className={ITEM_CLASS}
                      onClick={() => onTakeScreenshot("region")}
                    >
                      <Crop size={11} />
                      <span>Selected region</span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className={ITEM_CLASS}
                      onClick={() => onTakeScreenshot("full")}
                    >
                      <Monitor size={11} />
                      <span>Whole desktop</span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Popup>
                </DropdownMenu.Positioner>
              </DropdownMenu.Portal>
            </DropdownMenu.SubmenuRoot>

            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />

            <GithubSubmenu projectPath={projectPath} onCloneRepo={onCloneRepo} />

            <SessionsSubmenu
              projectPath={projectPath}
              agentId={agentId}
              onPickSession={onPickSession}
            />

            <ProjectSubmenu
              projectPath={projectPath}
              agentId={agentId}
              onPickProject={onPickProject}
            />

            {/* Zed-style registry entry point: opens Settings → Agents. Agent
                SWITCHING lives on the agent pill, not here — this menu is about
                what you attach to a message, and the pill's picker now offers
                one-click installs of its own (see FeaturedAgentOffers). */}
            <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettingsSection("agents");
              }}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs text-[var(--secondary-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
            >
              <Plus size={11} />
              Add more agents
            </button>
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
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
    <DropdownMenu.SubmenuRoot onOpenChange={(o) => o && loadCloned()}>
      <DropdownMenu.SubmenuTrigger className={ITEM_CLASS}>
        <GithubIcon size={11} />
        <span>Add from GitHub</span>
        <ChevronRight size={11} className="ml-auto text-[var(--muted-foreground)]" />
      </DropdownMenu.SubmenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" side="right" align="start" sideOffset={6}>
          <DropdownMenu.Popup className={cn(CONTENT_CLASS, "w-[300px]")}>
            {!projectPath ? (
              <div className="px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
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
                      <div className="px-3 pt-1 pb-0.5 text-3xs uppercase tracking-wide text-[var(--muted-foreground)]">
                        Downloaded
                      </div>
                      {cloned.map((c) => (
                        <DropdownMenu.Item
                          key={c.name}
                          disabled
                          className={cn(ITEM_CLASS, "opacity-60 data-[disabled]:opacity-60")}
                          title={`Already downloaded · ${c.path}`}
                        >
                          <FolderGit2
                            size={11}
                            className="shrink-0 text-[var(--muted-foreground)]"
                          />
                          <span className="truncate">{c.display_name}</span>
                          <Check
                            size={11}
                            className="ml-auto shrink-0 text-[var(--atlas-status-success-foreground)]"
                          />
                        </DropdownMenu.Item>
                      ))}
                      <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
                    </>
                  )}

                  {/* Search results. */}
                  {loading ? (
                    <div className="flex items-center gap-2 px-3 h-[26px] text-xs text-[var(--muted-foreground)]">
                      <Loader2 size={11} className="animate-spin" />
                      Searching…
                    </div>
                  ) : results === null ? (
                    <div className="px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
                      Type a repo name and press Enter.
                    </div>
                  ) : results.length === 0 ? (
                    <div className="px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
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
                          onClick={() => onCloneRepo(repo)}
                          title={repo.description || repo.full_name}
                        >
                          {already ? (
                            <Check
                              size={11}
                              className="mt-0.5 shrink-0 text-[var(--atlas-status-success-foreground)]"
                            />
                          ) : (
                            <Download
                              size={11}
                              className="mt-0.5 shrink-0 text-[var(--muted-foreground)]"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[var(--foreground)]">
                                {repo.full_name}
                              </span>
                              {already ? (
                                <span className="ml-auto shrink-0 text-3xs text-[var(--muted-foreground)]">
                                  downloaded
                                </span>
                              ) : (
                                <span className="ml-auto flex shrink-0 items-center gap-0.5 text-3xs text-[var(--muted-foreground)]">
                                  <Star size={9} /> {repo.stars}
                                </span>
                              )}
                            </div>
                            {repo.description && (
                              <div className="text-2xs text-[var(--muted-foreground)] line-clamp-2">
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
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.SubmenuRoot>
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
    <DropdownMenu.SubmenuRoot onOpenChange={(o) => o && load()}>
      <DropdownMenu.SubmenuTrigger className={ITEM_CLASS}>
        <MessageSquareText size={11} />
        <span>Attach a session</span>
        <ChevronRight size={11} className="ml-auto text-[var(--muted-foreground)]" />
      </DropdownMenu.SubmenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" side="right" align="start" sideOffset={6}>
          <DropdownMenu.Popup className={cn(CONTENT_CLASS, "w-[300px]")}>
            {!projectPath ? (
              <div className="px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
                Open a project to browse its sessions.
              </div>
            ) : (
              <>
                <SearchBox value={query} onChange={setQuery} placeholder="Search sessions…" />
                <div className="max-h-[300px] overflow-y-auto">
                  {sessions === null ? (
                    <div className="flex items-center gap-2 px-3 h-[26px] text-xs text-[var(--muted-foreground)]">
                      <Loader2 size={11} className="animate-spin" />
                      Loading sessions…
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
                      {sessions.length === 0 ? "No past sessions in this project." : "No matches."}
                    </div>
                  ) : (
                    filtered.map((s) => (
                      <DropdownMenu.Item
                        key={s.id}
                        className={cn(ITEM_CLASS, "h-auto items-start py-1.5")}
                        onClick={() => onPickSession(s)}
                        title={s.title}
                      >
                        <MessageSquareText
                          size={11}
                          className="mt-0.5 shrink-0 text-[var(--muted-foreground)]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[var(--foreground)]">{s.title}</div>
                          <div className="text-2xs text-[var(--muted-foreground)]">
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
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.SubmenuRoot>
  );
}

// ── Reference project — hand the agent another project's path ───────────────
// Mirrors `SessionsSubmenu`, but lists the OTHER projects in the active org
// (the same set the `@workspace` reference-picker rail surfaces). Picking one
// inserts a `@workspace` mention; at send time Rust expands it into that
// project's absolute path so an agent in p1 can be told to go inspect p3.
function ProjectSubmenu({
  projectPath,
  agentId,
  onPickProject,
}: {
  projectPath: string | null;
  agentId?: string;
  onPickProject: (project: MentionProject) => void;
}) {
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<MentionProject[] | null>(null);

  // `searchMentions("workspace")` reads the project + org stores synchronously
  // and filters to the active org, so this is effectively instant — but it stays
  // async to match the mention API and to re-run per keystroke for free.
  useEffect(() => {
    let cancelled = false;
    void searchMentions(query, "workspace", { projectPath, agentId })
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
  }, [query, projectPath, agentId]);

  return (
    <DropdownMenu.SubmenuRoot>
      <DropdownMenu.SubmenuTrigger className={ITEM_CLASS}>
        <Boxes size={11} />
        <span>Reference project</span>
        <ChevronRight size={11} className="ml-auto text-[var(--muted-foreground)]" />
      </DropdownMenu.SubmenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Positioner className="z-popover" side="right" align="start" sideOffset={6}>
          <DropdownMenu.Popup className={cn(CONTENT_CLASS, "w-[300px]")}>
            <SearchBox value={query} onChange={setQuery} placeholder="Search projects…" />
            <div className="max-h-[300px] overflow-y-auto">
              {projects === null ? (
                <div className="flex items-center gap-2 px-3 h-[26px] text-xs text-[var(--muted-foreground)]">
                  <Loader2 size={11} className="animate-spin" />
                  Loading projects…
                </div>
              ) : projects.length === 0 ? (
                <div className="px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
                  {query ? "No matches." : "No other projects in this organization."}
                </div>
              ) : (
                projects.map((w) => (
                  <DropdownMenu.Item
                    key={w.id}
                    className={cn(ITEM_CLASS, "h-auto items-start py-1.5")}
                    onClick={() => onPickProject(w)}
                    title={w.absPath}
                  >
                    <Boxes size={11} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[var(--foreground)]">{w.displayName}</div>
                      <div className="truncate text-2xs text-[var(--muted-foreground)]">
                        {w.absPath}
                      </div>
                    </div>
                  </DropdownMenu.Item>
                ))
              )}
            </div>
          </DropdownMenu.Popup>
        </DropdownMenu.Positioner>
      </DropdownMenu.Portal>
    </DropdownMenu.SubmenuRoot>
  );
}
