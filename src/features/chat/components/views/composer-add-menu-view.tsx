// The composer's "+" attach menu, drawn from props alone. The container
// (`../composer-add-menu.tsx`) owns the open state, the menu-exclusion event
// and every list the submenus show.
//
// The searchable submenus (GitHub, Sessions, Projects) embed a text input
// inside a submenu popup and stop keydown propagation so the menu's typeahead
// doesn't eat the keystrokes — the same pattern the project "+" AddProjectMenu
// uses.

import type { ReactNode } from "react";
import {
  Boxes,
  Camera,
  Check,
  Crop,
  Download,
  FolderGit2,
  Image as ImageIcon,
  MessageSquareText,
  Monitor,
  Paperclip,
  Plus,
  Search,
  Star,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Hint,
  Icon,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  PlusMinusGlyph,
  Spinner,
} from "@tryatlas/design";
import { GithubIcon } from "@/components/brand-marks";
import { cn } from "@/lib/utils";
import type { GithubRepo, ClonedRepo } from "@/features/github/types";
import type { MentionProject, PastSessionRef } from "../../lib/mentions";

export interface ComposerAddMenuViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  /** A project is open: the GitHub and Sessions submenus need one. */
  hasProject: boolean;
  /** Agent accepts inline base64 images (`promptCapabilities.image`). */
  imageSupported: boolean;
  onAddFilesOrPhotos: () => void;
  onAttachMedia: () => void;
  onTakeScreenshot: (mode: "region" | "full") => void;
  github: {
    query: string;
    onQuery: (q: string) => void;
    /** Enter in the search box. */
    onSearch: () => void;
    loading: boolean;
    /** `null` before the first search. */
    results: readonly GithubRepo[] | null;
    cloned: readonly ClonedRepo[];
    isCloned: (repo: GithubRepo) => boolean;
    /** The submenu opened: refresh the cloned list. */
    onOpen: () => void;
    onClone: (repo: GithubRepo) => void;
  };
  sessions: {
    query: string;
    onQuery: (q: string) => void;
    /** Every past session; `null` while loading. */
    all: readonly PastSessionRef[] | null;
    filtered: readonly PastSessionRef[];
    /** The submenu opened: load the list (once per menu open). */
    onOpen: () => void;
    onPick: (session: PastSessionRef) => void;
  };
  projects: {
    query: string;
    onQuery: (q: string) => void;
    /** `null` while loading. */
    rows: readonly MentionProject[] | null;
    onPick: (project: MentionProject) => void;
  };
  /** Closes the menu and opens Settings → Agents. */
  onAddMoreAgents: () => void;
}

export function ComposerAddMenuView({
  open,
  onOpenChange,
  disabled,
  hasProject,
  imageSupported,
  onAddFilesOrPhotos,
  onAttachMedia,
  onTakeScreenshot,
  github,
  sessions,
  projects,
  onAddMoreAgents,
}: ComposerAddMenuViewProps) {
  // The composer's own round "+" — a footer pill's size and surface, not a
  // menu button's.
  const trigger = (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex size-6.5 items-center justify-center rounded-full border border-border",
        "bg-card text-secondary-foreground transition-colors outline-none",
        disabled
          ? "opacity-50 cursor-default"
          : "hover:bg-element-hover hover:text-foreground cursor-pointer",
      )}
    >
      <PlusMinusGlyph open={open} size="md" />
    </button>
  );
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {/* `wrap`: the Trigger has no `disabled` prop for Hint to detect, but its button does. */}
      <Hint label="Attach files, media, repos, or a past session" side="top" wrap>
        <DropdownMenuTrigger render={trigger} />
      </Hint>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="min-w-[210px]">
        <DropdownMenuItem onClick={onAddFilesOrPhotos}>
          <Icon icon={Paperclip} size="sm" />
          <span>{imageSupported ? "Add files or photos" : "Add files"}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAttachMedia}>
          <Icon icon={ImageIcon} size="sm" />
          <span>Attach media</span>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon icon={Camera} size="sm" />
            <span>Take a screenshot</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent sideOffset={6} className="min-w-[190px]">
            <DropdownMenuItem onClick={() => onTakeScreenshot("region")}>
              <Icon icon={Crop} size="sm" />
              <span>Selected region</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTakeScreenshot("full")}>
              <Icon icon={Monitor} size="sm" />
              <span>Whole desktop</span>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        {/* ── Add from GitHub — search remote repos, clone into `.atlas/repos` */}
        <DropdownMenuSub onOpenChange={(o) => o && github.onOpen()}>
          <DropdownMenuSubTrigger>
            <GithubIcon size={12} />
            <span>Add from GitHub</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent sideOffset={6} className="w-[300px]">
            {!hasProject ? (
              <MenuNote>Open a project to clone repos into it.</MenuNote>
            ) : (
              <>
                <SearchBox
                  value={github.query}
                  onChange={github.onQuery}
                  placeholder="Search GitHub repos…  (Enter)"
                  onEnter={github.onSearch}
                />
                <div className="max-h-[300px] overflow-y-auto">
                  {/* Already-downloaded repos — a plain, disabled list. */}
                  {github.cloned.length > 0 && (
                    <>
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Downloaded</DropdownMenuLabel>
                        {github.cloned.map((c) => (
                          <DropdownMenuItem
                            key={c.name}
                            disabled
                            title={`Already downloaded · ${c.path}`}
                          >
                            <Icon icon={FolderGit2} size="sm" className="text-muted-foreground" />
                            <span className="truncate">{c.display_name}</span>
                            <Icon icon={Check} size="sm" className="ml-auto text-success" />
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                    </>
                  )}

                  {/* Search results. */}
                  {github.loading ? (
                    <MenuNote loading>Searching…</MenuNote>
                  ) : github.results === null ? (
                    <MenuNote>Type a repo name and press Enter.</MenuNote>
                  ) : github.results.length === 0 ? (
                    <MenuNote>No repositories found.</MenuNote>
                  ) : (
                    github.results.map((repo) => {
                      const already = github.isCloned(repo);
                      return (
                        <DropdownMenuItem
                          key={repo.full_name}
                          disabled={already}
                          className="items-start"
                          onClick={() => github.onClone(repo)}
                          title={repo.description || repo.full_name}
                        >
                          {already ? (
                            <Icon icon={Check} size="sm" className="mt-0.5 text-success" />
                          ) : (
                            <Icon
                              icon={Download}
                              size="sm"
                              className="mt-0.5 text-muted-foreground"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-foreground">{repo.full_name}</span>
                              {already ? (
                                <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
                                  downloaded
                                </span>
                              ) : (
                                <span className="ml-auto flex shrink-0 items-center gap-0.5 text-3xs text-muted-foreground">
                                  <Icon icon={Star} size="xs" /> {repo.stars}
                                </span>
                              )}
                            </div>
                            {repo.description && (
                              <div className="line-clamp-2 text-2xs text-muted-foreground">
                                {repo.description}
                              </div>
                            )}
                          </div>
                        </DropdownMenuItem>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* ── Attach a session — reference a past session's transcript */}
        <DropdownMenuSub onOpenChange={(o) => o && sessions.onOpen()}>
          <DropdownMenuSubTrigger>
            <Icon icon={MessageSquareText} size="sm" />
            <span>Attach a session</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent sideOffset={6} className="w-[300px]">
            {!hasProject ? (
              <MenuNote>Open a project to browse its sessions.</MenuNote>
            ) : (
              <>
                <SearchBox
                  value={sessions.query}
                  onChange={sessions.onQuery}
                  placeholder="Search sessions…"
                />
                <div className="max-h-[300px] overflow-y-auto">
                  {sessions.all === null ? (
                    <MenuNote loading>Loading sessions…</MenuNote>
                  ) : sessions.filtered.length === 0 ? (
                    <MenuNote>
                      {sessions.all.length === 0
                        ? "No past sessions in this project."
                        : "No matches."}
                    </MenuNote>
                  ) : (
                    sessions.filtered.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        className="items-start"
                        onClick={() => sessions.onPick(s)}
                        title={s.title}
                      >
                        <Icon
                          icon={MessageSquareText}
                          size="sm"
                          className="mt-0.5 text-muted-foreground"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-foreground">{s.title}</div>
                          <div className="text-2xs text-muted-foreground">
                            {s.messageCount} message
                            {s.messageCount === 1 ? "" : "s"}
                          </div>
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </div>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* ── Reference project — hand the agent another project's path.
            Lists the OTHER projects in the active org (the same set the
            `@workspace` reference-picker rail surfaces). Picking one inserts a
            `@workspace` mention; at send time Rust expands it into that
            project's absolute path so an agent in p1 can be told to go inspect
            p3. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Icon icon={Boxes} size="sm" />
            <span>Reference project</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent sideOffset={6} className="w-[300px]">
            <SearchBox
              value={projects.query}
              onChange={projects.onQuery}
              placeholder="Search projects…"
            />
            <div className="max-h-[300px] overflow-y-auto">
              {projects.rows === null ? (
                <MenuNote loading>Loading projects…</MenuNote>
              ) : projects.rows.length === 0 ? (
                <MenuNote>
                  {projects.query ? "No matches." : "No other projects in this organization."}
                </MenuNote>
              ) : (
                projects.rows.map((w) => (
                  <DropdownMenuItem
                    key={w.id}
                    className="items-start"
                    onClick={() => projects.onPick(w)}
                    title={w.absPath}
                  >
                    <Icon icon={Boxes} size="sm" className="mt-0.5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground">{w.displayName}</div>
                      <div className="truncate text-2xs text-muted-foreground">{w.absPath}</div>
                    </div>
                  </DropdownMenuItem>
                ))
              )}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Registry entry point: opens Settings → Agents. Agent SWITCHING
            lives on the agent pill, not here — this menu is about what you
            attach to a message, and the pill's picker now offers one-click
            installs of its own (see FeaturedAgentOffers). A plain button, not
            a menu item: making it one changes keyboard reach (ATL-718). */}
        <DropdownMenuSeparator />
        <button
          type="button"
          onClick={onAddMoreAgents}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-xs text-secondary-foreground transition-colors hover:text-foreground"
        >
          <Icon icon={Plus} size="sm" />
          Add more agents
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A status or empty line inside a submenu. */
function MenuNote({ loading = false, children }: { loading?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
      {loading && <Spinner size="sm" label="" />}
      {children}
    </div>
  );
}

// Shared search-box header for the searchable submenus.
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
  // NOTE: deliberately NOT auto-focused. A submenu opened by HOVER keeps focus
  // on its SubTrigger; programmatically focusing this input pulls focus off the
  // trigger and makes the PARENT menu's highlight jump to another item (the
  // reported glitch). Click-to-focus is the standard for a hover-opened menu
  // search box. `stopPropagation` keeps the menu's typeahead from stealing
  // keystrokes once the box has focus — every key EXCEPT Escape: Base UI
  // listens for Escape in the bubble phase (Radix used capture), so swallowing
  // it here left the submenu impossible to dismiss from the box.
  return (
    <div
      className="p-1"
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      <InputGroup>
        <InputGroupAddon>
          <Icon icon={Search} size="sm" />
        </InputGroupAddon>
        <InputGroupInput
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter?.();
          }}
          placeholder={placeholder}
        />
      </InputGroup>
    </div>
  );
}
