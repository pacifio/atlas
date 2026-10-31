// ⌘K and ⌘P: one search overlay, two modes.
//
// The command mode is "Actions" (new session, go to file, projects, theme,
// pull requests, usage, settings), then "Recent Sessions", then Atlas's own
// groups (tabs, layout, splits). Typing searches all of it, plus every
// project and every session, with one ranking (`command-palette-logic.ts`).
// A submenu row ("New session in…", "Change theme") drills in; Backspace on
// an empty field or Escape comes back out.
//
// The file mode is `file-search.tsx`. Opened from "Go to file", its Escape
// returns here with the query it left; opened by ⌘P, Escape closes it.

import { useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRightToLine,
  Brain,
  BrainCircuit,
  ChartNoAxesColumn,
  Circle,
  Code,
  Columns2,
  FileSearch,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Globe,
  Map as MapIcon,
  Maximize2,
  MessageSquare,
  Network,
  PanelRight,
  ScrollText,
  Search,
  Settings,
  Sidebar,
  SquareArrowOutUpRight,
  SquarePen,
  Terminal,
  TextSearch,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "@/ui/icon";
import { CommandDialog, CommandDialogPopup } from "@/ui/command";
import type { TabType } from "@/lib/constants";
import { useAppStore } from "@/features/app/stores/app-store";
import { recentsForOrg } from "@/features/app/lib/recent-projects";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { revealSourceControl, toggleSourceControl } from "@/features/layout/lib/source-control";
import { revealFiles, toggleFiles } from "@/features/layout/lib/files-surface";
import { toggleTeamChat } from "@/features/layout/lib/team-chat";
import { openCapture } from "@/features/capture/lib/open-capture";
import { openDestination } from "@/features/layout/lib/destinations";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { pickAndAddProject } from "@/features/projects/lib/pick-project";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { activateProject, openProjectSettings } from "@/features/sidebar/lib/sidebar-actions";
import { useActiveSessionId } from "@/features/sidebar/hooks/use-sidebar-sessions";
import { findSession } from "@/features/sidebar/lib/find-session";
import { ProjectBadge } from "@/features/sidebar/components/session-row-parts";
import { openPullRequestListTab } from "@/features/pull-requests/lib/open-pull-request-list-tab";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { runAction } from "@/features/keybindings/lib/action-registry";
import {
  editorName,
  openInEditor,
  usePreferredEditor,
} from "@/features/external-editor/lib/preferred-editor";
import { getEditorPosition } from "@/features/editor/lib/editor-views";
import { useCommandPaletteStore } from "../stores/command-palette-store";
import {
  RECENT_SESSION_LIMIT,
  ROOT_PLACEHOLDER,
  buildRootGroups,
  commandPaletteEmptyMessage,
  createCommandPaletteSearchState,
  enumerateCommandPaletteItems,
  filterCommandPaletteGroups,
  reduceCommandPaletteSearchState,
  type CommandPaletteActionItem,
  type CommandPaletteEntry,
  type CommandPaletteGroup,
  type CommandPaletteInitialView,
  type CommandPaletteReturnContext,
  type CommandPaletteView,
} from "../lib/command-palette-logic";
import { buildSessionActionItems, usePaletteSessions } from "../lib/palette-sessions";
import {
  ADD_PROJECT_ENTRY,
  ADD_PROJECT_VIEW,
  NEW_PROJECT_VIEW,
  useAddProjectFlow,
} from "../lib/palette-add-project";
import { usePaletteThemeItems } from "../lib/palette-theme-items";
import {
  CommandEscapeContext,
  CommandPaletteContent,
  useCommandEscape,
} from "./command-palette-content";
import { FileSearch as FileSearchView } from "./file-search";

/** The overlay, mounted once at the app root. */
export function CommandPalette() {
  const ui = useCommandPaletteStore.use.ui();
  const { dispatch, setOpen } = useCommandPaletteStore.use.actions();
  const escape = useCommandEscape();

  return (
    <CommandDialog
      open={ui.open}
      onOpenChange={(open, details) => {
        // Escape in a submenu goes back out of it.
        if (escape.interceptEscape(open, details)) return;
        // Escape in a child search opened from the palette goes back to it.
        if (!open && details.reason === "escape-key" && ui.mode !== "command" && ui.parentSearch) {
          details.cancel();
          dispatch({ _tag: "BackToCommand" });
          return;
        }
        setOpen(open);
      }}
    >
      <CommandDialogPopup
        title={ui.mode === "files" ? "Go to file" : "Command palette"}
        data-palette-mode={ui.mode}
      >
        <CommandEscapeContext.Provider value={escape.ref}>
          {ui.mode === "files" ? (
            <FileSearchView
              onClose={() => setOpen(false)}
              escapeLabel={ui.parentSearch ? "Back" : "Close"}
            />
          ) : (
            <OpenCommandPalette
              // A fresh palette per `OpenView`: its view stack is pushed once,
              // on mount, so a second ⌘⇧N while open needs a new mount.
              key={ui.initialViewRequest ?? 0}
              initialContext={ui.restoredSearch}
              initialView={ui.initialView}
              onClose={() => setOpen(false)}
            />
          )}
        </CommandEscapeContext.Provider>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

const ICON = (icon: LucideIcon) => <Icon icon={icon} size="lg" />;

/** Singletons get a stable id, so running one again focuses it. */
const SINGLETON_TABS: ReadonlySet<TabType> = new Set([
  "knowledge",
  "knowledge-graph",
  "memory",
  "log",
  "usage",
]);

function openTab(type: TabType, title: string): void {
  useLayoutStore.getState().actions.addTab({
    id: SINGLETON_TABS.has(type) ? type : `${type}-${Date.now()}`,
    type,
    title,
    closable: true,
    dirty: false,
    data: {},
  });
}

function action(
  value: string,
  title: ReactNode,
  icon: LucideIcon,
  run: () => void | Promise<void>,
  extra: Partial<CommandPaletteActionItem> & { searchTerms?: readonly string[] } = {},
): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    title,
    icon: ICON(icon),
    run,
    ...extra,
    searchTerms: [typeof title === "string" ? title : value, ...(extra.searchTerms ?? [])],
  };
}

function OpenCommandPalette(props: {
  initialContext: CommandPaletteReturnContext | undefined;
  /** A view to open straight onto (⌘⇧O's project list). */
  initialView: CommandPaletteInitialView | undefined;
  onClose: () => void;
}) {
  const { onClose } = props;
  const { dispatch } = useCommandPaletteStore.use.actions();
  const [search, dispatchSearch] = useReducer(
    reduceCommandPaletteSearchState,
    props.initialContext?.query ?? "",
    createCommandPaletteSearchState,
  );
  const { query, views } = search;
  const currentView = views[views.length - 1]?.view ?? null;
  const isSubmenu = currentView !== null;

  const currentProject = useAppStore.use.currentProject();
  const projectPath = currentProject?.path ?? null;
  const orgProjects = useActiveOrgProjects();
  const allRecents = useAppStore.use.recentProjects();
  const registry = useProjectStore.use.projects();
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  const sessions = usePaletteSessions();
  const activeSessionId = useActiveSessionId();
  const { changeThemeItem, changeAppearanceItem, themeEditorItem } = usePaletteThemeItems();
  const { preferred: editor } = usePreferredEditor();
  const activeFile = useLayoutStore((s) => {
    const id = s.activeByGroup[s.focusedGroupId];
    const tab = id ? s.tabs.find((t) => t.id === id) : undefined;
    const path = tab?.type === "editor" ? tab.data.filePath : undefined;
    return typeof path === "string" && !path.startsWith("untitled:") ? path : null;
  });
  const activeTabId = useLayoutStore((s) => s.activeByGroup[s.focusedGroupId] ?? null);

  const pushView = (view: CommandPaletteView) => dispatchSearch({ type: "push", view });
  const popView = () => dispatchSearch({ type: "back" });

  // ── Projects ──────────────────────────────────────────────────────────────
  const projectBadge = (name: string, path: string) => (
    <ProjectBadge name={name} path={path} className="size-4" />
  );
  const newSessionInItems: CommandPaletteActionItem[] = enumerateCommandPaletteItems(
    orgProjects.map((project) => ({
      kind: "action",
      value: `new-session-in:${project.id}`,
      title: project.name,
      description: project.path,
      searchTerms: [project.name, project.path],
      icon: projectBadge(project.name, project.path),
      run: async () => {
        await activateProject(project.path);
        openNewAgentChat();
      },
    })),
  );
  const projectSearchItems: CommandPaletteActionItem[] = orgProjects.map((project) => ({
    kind: "action",
    value: `project:${project.id}`,
    title: project.name,
    description: project.path,
    searchTerms: [project.name, project.path, "project"],
    icon: projectBadge(project.name, project.path),
    run: () => activateProject(project.path),
  }));
  const recentProjectItems: CommandPaletteActionItem[] = recentsForOrg(
    allRecents,
    registry,
    activeOrgId,
  )
    .filter((recent) => !orgProjects.some((p) => p.path === recent.path))
    .map((recent) => ({
      kind: "action",
      value: `add-project:${recent.path}`,
      title: recent.name,
      description: recent.path,
      searchTerms: [recent.name, recent.path],
      icon: ICON(Folder),
      run: () => void useProjectStore.getState().actions.addProject(recent.path),
    }));

  const newSessionInView: CommandPaletteView = {
    value: "new-session-in",
    placeholder: "Search projects…",
    groups: [{ value: "projects", label: "Projects", items: newSessionInItems }],
  };

  // ── Actions (the reference app's set, mapped onto Atlas) ──────────────────
  const actionItems: CommandPaletteEntry[] = [
    currentProject
      ? action(
          "action:new-session",
          <>
            New session in <span className="font-semibold">{currentProject.name}</span>
          </>,
          SquarePen,
          () => void openNewAgentChat(),
          {
            searchTerms: ["new session", currentProject.name, "agent", "create"],
            shortcutAction: "tabs.newChat",
          },
        )
      : action("action:new-session", "New session", SquarePen, () => void openNewAgentChat(), {
          searchTerms: ["agent", "create"],
          shortcutAction: "tabs.newChat",
        }),
  ];
  if (orgProjects.length > 0) {
    actionItems.push({
      kind: "submenu",
      value: "action:new-session-in",
      title: "New session in…",
      searchTerms: ["new session in", "project", "pick", "choose"],
      icon: ICON(SquarePen),
      groups: newSessionInView.groups,
      placeholder: newSessionInView.placeholder,
    });
  }
  actionItems.push(
    action(
      "action:go-to-file",
      "Go to file",
      FileSearch,
      () => dispatch({ _tag: "OpenChildSearch", mode: "files", context: { query } }),
      {
        searchTerms: ["open file", "file picker", "find file", "quick open"],
        shortcutAction: "nav.filePicker",
        keepOpen: true,
      },
    ),
    action(
      "action:search-project-contents",
      "Search project contents",
      TextSearch,
      () => void runAction("nav.search"),
      {
        searchTerms: ["find in files", "grep", "content search", "text search"],
        shortcutAction: "nav.search",
      },
    ),
    action(
      "action:new-project",
      "New project",
      FolderGit2,
      () => pushView({ value: NEW_PROJECT_VIEW, groups: [], placeholder: "Project name" }),
      {
        searchTerms: ["create project", "new folder", "empty", "git init"],
        keepOpen: true,
      },
    ),
    {
      kind: "submenu",
      // The flow's own view id: its steps are built live by `useAddProjectFlow`.
      value: ADD_PROJECT_VIEW,
      title: "Add project",
      searchTerms: ["add project", "open folder", "folder", "directory", "recent projects"],
      icon: ICON(FolderPlus),
      groups: ADD_PROJECT_ENTRY.groups,
      placeholder: ADD_PROJECT_ENTRY.placeholder,
      shortcutAction: "workspace.add",
    },
    changeThemeItem,
    changeAppearanceItem,
    themeEditorItem,
  );
  if (projectPath) {
    actionItems.push(
      action(
        "action:pull-requests",
        "Open pull requests",
        GitPullRequest,
        () => openPullRequestListTab({ repoPath: projectPath }),
        { searchTerms: ["pull requests", "prs", "pr", "github", "review", "show pull requests"] },
      ),
    );
  }
  actionItems.push(
    action("action:usage", "Open usage", ChartNoAxesColumn, () => openDestination("usage"), {
      searchTerms: ["usage", "tokens", "cost", "spend", "limits", "analytics"],
      shortcutAction: "usage.open",
    }),
    action("action:settings", "Open settings", Settings, () => openSettingsSection(), {
      searchTerms: ["settings", "preferences", "configuration", "keybindings"],
      shortcutAction: "app.settings",
    }),
    action(
      "action:project-settings",
      "Project settings",
      Folder,
      () => {
        if (projectPath) openProjectSettings(projectPath);
      },
      {
        searchTerms: ["project", "settings", "name", "scripts", "instructions"],
        description: currentProject?.name ?? "No project",
        disabled: !projectPath,
      },
    ),
  );

  // ── Atlas's own groups ────────────────────────────────────────────────────
  const projectGroup: CommandPaletteActionItem[] = [
    action("project:open-folder", "Open folder…", FolderOpen, () => pickAndAddProject()),
    action("project:find-session", "Find session…", Search, findSession, {
      searchTerms: ["search sessions", "sidebar"],
    }),
  ];
  if (editor && projectPath) {
    projectGroup.push(
      action(
        "project:open-in-editor",
        `Open project in ${editorName(editor)}`,
        SquareArrowOutUpRight,
        () => void openInEditor(editor.id, projectPath),
      ),
    );
  }
  if (editor && activeFile) {
    projectGroup.push(
      action(
        "project:open-file-in-editor",
        `Open file in ${editorName(editor)}`,
        SquareArrowOutUpRight,
        () => {
          const cursor = activeTabId ? getEditorPosition(activeTabId)?.cursor : undefined;
          void openInEditor(
            editor.id,
            activeFile,
            cursor ? { line: cursor.line, column: cursor.col } : undefined,
          );
        },
      ),
    );
  }
  const extraGroups: CommandPaletteGroup[] = [
    { value: "project", label: "Project", items: projectGroup },
    {
      value: "open",
      label: "Open",
      items: [
        action("open:spaces", "New space", MapIcon, () => openTab("canvas", "Spaces"), {
          searchTerms: ["spaces", "canvas"],
        }),
        action("open:terminal", "New terminal", Terminal, () => openTab("terminal", "Terminal"), {
          shortcutAction: "tabs.newTerminal",
        }),
        action(
          "open:editor",
          "New untitled editor",
          Code,
          () => void runAction("tabs.newUntitled"),
          {
            shortcutAction: "tabs.newUntitled",
          },
        ),
        action("open:browser", "Open browser", Globe, () => openTab("browser", "Browser")),
        action("open:knowledge", "Knowledge base", Brain, () => openTab("knowledge", "Knowledge")),
        action("open:knowledge-graph", "Knowledge graph", Network, () =>
          openTab("knowledge-graph", "Graph"),
        ),
        action("open:memory", "Memory", BrainCircuit, () => openTab("memory", "Memory")),
        action("open:log", "Log", ScrollText, () => openTab("log", "Log")),
        action("open:capture", "Open session capture", Circle, openCapture, {
          shortcutAction: "app.capture",
        }),
      ],
    },
    {
      value: "layout",
      label: "Layout",
      items: [
        action("layout:files", "Toggle files", FolderTree, toggleFiles, {
          shortcutAction: "panels.left",
        }),
        action("layout:source-control", "Toggle source control", GitBranch, toggleSourceControl, {
          shortcutAction: "panels.right",
        }),
        action("layout:team-chat", "Toggle team chat", MessageSquare, toggleTeamChat, {
          shortcutAction: "panels.teamChat",
        }),
        action(
          "layout:sidebar",
          "Toggle sidebar",
          Sidebar,
          () => useProjectStore.getState().actions.toggleSidebar(),
          { shortcutAction: "workspace.toggleSidebar" },
        ),
        action("layout:zen", "Toggle zen mode", Maximize2, () => void runAction("panels.zen"), {
          shortcutAction: "panels.zen",
        }),
        action("layout:show-files", "Show files", FolderTree, () => revealFiles()),
        action("layout:show-changes", "Show source control", PanelRight, () =>
          revealSourceControl("changes"),
        ),
        action("layout:show-git-graph", "Show git graph", GitBranch, () =>
          revealSourceControl("git-graph"),
        ),
      ],
    },
    {
      value: "split",
      label: "Split",
      items: [
        action("split:new", "Split: new column", Columns2, () => void runAction("split.new"), {
          shortcutAction: "split.new",
        }),
        action(
          "split:focus-left",
          "Split: focus left",
          ArrowLeftToLine,
          () => void runAction("split.focusLeft"),
          {
            shortcutAction: "split.focusLeft",
          },
        ),
        action(
          "split:focus-right",
          "Split: focus right",
          ArrowRightToLine,
          () => void runAction("split.focusRight"),
          { shortcutAction: "split.focusRight" },
        ),
        action(
          "split:close",
          "Split: close column",
          Columns2,
          () => void runAction("split.close"),
          {
            shortcutAction: "split.close",
          },
        ),
      ],
    },
  ];

  // ── Sessions ──────────────────────────────────────────────────────────────
  const sessionItems = useMemo(
    () => buildSessionActionItems({ sessions, activeSessionId }),
    [sessions, activeSessionId],
  );
  const recentSessionItems = sessionItems.slice(0, RECENT_SESSION_LIMIT);

  const addProjectStep = useAddProjectFlow({
    view: currentView?.value,
    query,
    setQuery: (next) => dispatchSearch({ type: "query", query: next }),
    pushView,
    popView,
    onClose,
    recentItems: recentProjectItems,
  });

  // ⌘⇧O opens straight onto the project list.
  const initialView = props.initialView;
  const openedInitialView = useRef(false);
  useLayoutEffect(() => {
    if (openedInitialView.current) return;
    openedInitialView.current = true;
    if (initialView === "new-session-in") pushView(newSessionInView);
    if (initialView === "add-project") pushView(ADD_PROJECT_ENTRY);
    // Once, on open: the view stack is the user's after that.
  }, [initialView, newSessionInView]);

  const rootGroups = buildRootGroups({ actionItems, recentSessionItems, extraGroups });
  const activeGroups = addProjectStep?.groups ?? currentView?.groups ?? rootGroups;
  // The flow's steps past the source list run on the field's text, not a
  // search over their rows.
  const filtersRows = !addProjectStep || currentView?.value === ADD_PROJECT_VIEW;
  const displayedGroups = filtersRows
    ? filterCommandPaletteGroups({
        activeGroups,
        query,
        isInSubmenu: isSubmenu,
        projectSearchItems,
        sessionSearchItems: sessionItems,
      })
    : activeGroups;

  const executeItem = (item: CommandPaletteEntry) => {
    if (item.disabled) return;
    if (item.kind === "submenu") {
      pushView({ value: item.value, groups: item.groups, placeholder: item.placeholder });
      return;
    }
    if (!item.keepOpen) onClose();
    void Promise.resolve(item.run()).catch((error: unknown) => {
      console.error("command palette action failed", error);
    });
  };

  const isActionsOnly = query.startsWith(">");
  return (
    <CommandPaletteContent
      // A new view is a new list: its highlight starts at its top.
      key={`${views.length}:${currentView?.value ?? "root"}`}
      groups={displayedGroups}
      query={query}
      onQueryChange={(next) => dispatchSearch({ type: "query", query: next })}
      onExecute={executeItem}
      placeholder={
        addProjectStep?.placeholder ??
        currentView?.placeholder ??
        (isSubmenu ? "Search…" : ROOT_PLACEHOLDER)
      }
      emptyMessage={addProjectStep?.emptyMessage ?? commandPaletteEmptyMessage(isActionsOnly)}
      footerActionLabel={addProjectStep?.footerActionLabel ?? "Select"}
      footerTrailing={addProjectStep?.footerTrailing}
      endAddon={addProjectStep?.endAddon}
      onSubmit={addProjectStep?.onSubmit}
      disabled={addProjectStep?.disabled}
      // Escape closes the palette from any depth; Backspace on an empty field
      // is the way back out of a submenu.
      escapeLabel="Close"
      onBack={isSubmenu ? popView : undefined}
      startAddon={
        isSubmenu ? (
          <button
            type="button"
            aria-label="Back"
            onMouseDown={(event) => event.preventDefault()}
            onClick={popView}
            className="flex cursor-pointer items-center text-muted-foreground hover:text-foreground"
          >
            <Icon icon={ArrowLeft} size="lg" />
          </button>
        ) : undefined
      }
      testId="command-palette"
    />
  );
}
