import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  Fragment,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { KbdCombo } from "@/ui/kbd";
import { AtlasIcon } from "@/components/atlas-icon";
import {
  MessageSquare,
  Map,
  Globe,
  CheckSquare,
  Terminal,
  Settings,
  PanelLeft,
  PanelRight,
  PanelBottom,
  PanelTop,
  Sidebar,
  Columns2,
  Maximize2,
  Activity,
  Network,
  BrainCircuit,
  ScrollText,
  Timer,
  Code,
  GitBranch,
  ArrowLeftToLine,
  ArrowRightToLine,
  BookOpen,
  Brain,
  Search,
  FolderOpen,
} from "lucide-react";
import type { TabType } from "@/lib/constants";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon: React.ElementType;
  action: () => void;
  category: string;
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const {
    addTab,
    toggleLeftPanel,
    toggleRightPanel,
    toggleBottomPanel,
    toggleChatSidebar,
    toggleModelChatSidebar,
    toggleTabBar,
    toggleZenMode,
    toggleUsagePanel,
    setLeftSection,
    setRightSection,
    addGroup,
    focusAdjacentGroup,
    closeGroup,
  } = useLayoutStore.use.actions();
  const { openProject } = useProjectStore.use.actions();

  const handleOpenFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true });
      if (selected) {
        openProject(selected as string);
      }
    } catch {
      // dialog not available
    }
  };

  // Open a tab. Singletons get a stable id so re-running focuses the existing
  // one instead of stacking duplicates; multi-instance types get a fresh id.
  const SINGLETON: ReadonlySet<TabType> = new Set([
    "knowledge",
    "knowledge-graph",
    "memory",
    "log",
    "pomodoro",
    "settings",
  ]);
  const openTab = (type: TabType, title: string) =>
    addTab({
      id: SINGLETON.has(type) ? type : `${type}-${Date.now()}`,
      type,
      title,
      closable: true,
      dirty: false,
      data: {},
    });

  // Reveal the sidebar (toggle it on if hidden) then switch its active section.
  const showLeft = (section: "files" | "knowledge") => {
    if (!useLayoutStore.getState().leftPanel.visible) toggleLeftPanel();
    setLeftSection(section);
  };
  const showRight = (section: "changes" | "github" | "git-graph") => {
    if (!useLayoutStore.getState().rightPanel.visible) toggleRightPanel();
    setRightSection(section);
  };

  const commands = useMemo<Command[]>(
    () => [
      // ── Project ──
      {
        id: "open-folder",
        label: "Open Folder",
        icon: FolderOpen,
        category: "Project",
        action: handleOpenFolder,
      },

      // ── Open tabs ──
      {
        id: "new-agents-chat",
        label: "New Agents Chat",
        shortcut: "⌘T",
        icon: AtlasIcon,
        category: "Open",
        action: () => openTab("chat", "Agents"),
      },
      {
        id: "new-model-chat",
        label: "New Chat",
        icon: MessageSquare,
        category: "Open",
        action: () => openTab("model-chat", "Chat"),
      },
      {
        id: "new-terminal",
        label: "New Terminal",
        shortcut: "⌘⇧T",
        icon: Terminal,
        category: "Open",
        action: () => openTab("terminal", "Terminal"),
      },
      {
        id: "new-editor",
        label: "New Untitled Editor",
        shortcut: "⌘N",
        icon: Code,
        category: "Open",
        action: () => openTab("editor", "Untitled"),
      },
      {
        id: "new-canvas",
        label: "New Spaces",
        icon: Map,
        category: "Open",
        action: () => openTab("canvas", "Spaces"),
      },
      {
        id: "new-browser",
        label: "Open Browser",
        icon: Globe,
        category: "Open",
        action: () => openTab("browser", "Browser"),
      },
      {
        id: "new-tasks",
        label: "Task Board",
        icon: CheckSquare,
        category: "Open",
        action: () => openTab("tasks", "Tasks"),
      },
      {
        id: "new-research",
        label: "Research",
        icon: BookOpen,
        category: "Open",
        action: () => openTab("research", "Research"),
      },
      {
        id: "new-knowledge",
        label: "Knowledge Base",
        icon: Brain,
        category: "Open",
        action: () => openTab("knowledge", "Knowledge"),
      },
      {
        id: "new-knowledge-graph",
        label: "Knowledge Graph",
        icon: Network,
        category: "Open",
        action: () => openTab("knowledge-graph", "Graph"),
      },
      {
        id: "new-memory",
        label: "Memory",
        icon: BrainCircuit,
        category: "Open",
        action: () => openTab("memory", "Memory"),
      },
      {
        id: "new-log",
        label: "Log",
        icon: ScrollText,
        category: "Open",
        action: () => openTab("log", "Log"),
      },
      {
        id: "new-pomodoro",
        label: "Pomodoro",
        icon: Timer,
        category: "Open",
        action: () => openTab("pomodoro", "Pomodoro"),
      },

      // ── Layout toggles ──
      {
        id: "toggle-left",
        label: "Toggle Left Panel",
        shortcut: "⌘B",
        icon: PanelLeft,
        category: "Layout",
        action: toggleLeftPanel,
      },
      {
        id: "toggle-right",
        label: "Toggle Right Panel",
        shortcut: "⌘⇧B",
        icon: PanelRight,
        category: "Layout",
        action: toggleRightPanel,
      },
      {
        id: "toggle-bottom",
        label: "Toggle Bottom Panel",
        shortcut: "⌘⌥B",
        icon: PanelBottom,
        category: "Layout",
        action: toggleBottomPanel,
      },
      {
        id: "toggle-chat-sidebar",
        label: "Toggle Chat Sidebar",
        shortcut: "⌘⌥J",
        icon: Sidebar,
        category: "Layout",
        action: toggleChatSidebar,
      },
      {
        id: "toggle-model-chat-sidebar",
        label: "Toggle Chat History Sidebar",
        shortcut: "⌘⌥K",
        icon: Sidebar,
        category: "Layout",
        action: toggleModelChatSidebar,
      },
      {
        id: "toggle-tab-bar",
        label: "Toggle Tab Bar",
        shortcut: "⌘⌥T",
        icon: PanelTop,
        category: "Layout",
        action: toggleTabBar,
      },
      {
        id: "toggle-usage",
        label: "Toggle Usage Report",
        icon: Activity,
        category: "Layout",
        action: toggleUsagePanel,
      },
      {
        id: "toggle-zen",
        label: "Toggle Zen Mode",
        shortcut: "⌥Z",
        icon: Maximize2,
        category: "Layout",
        action: toggleZenMode,
      },

      // ── Splits ──
      {
        id: "split-new",
        label: "Split: New Column",
        shortcut: "⌘\\",
        icon: Columns2,
        category: "Split",
        action: () => addGroup(),
      },
      {
        id: "split-focus-left",
        label: "Split: Focus Left",
        shortcut: "⌥;",
        icon: ArrowLeftToLine,
        category: "Split",
        action: () => focusAdjacentGroup(-1),
      },
      {
        id: "split-focus-right",
        label: "Split: Focus Right",
        shortcut: "⌥'",
        icon: ArrowRightToLine,
        category: "Split",
        action: () => focusAdjacentGroup(1),
      },
      {
        id: "split-close",
        label: "Split: Close Column",
        shortcut: "⌥W",
        icon: Columns2,
        category: "Split",
        action: () => closeGroup(useLayoutStore.getState().focusedGroupId),
      },

      // ── Views (reveal the panel, then switch its section) ──
      {
        id: "view-files",
        label: "Show File Explorer",
        icon: PanelLeft,
        category: "View",
        action: () => showLeft("files"),
      },
      {
        id: "view-knowledge",
        label: "Show Knowledge Sidebar",
        icon: Brain,
        category: "View",
        action: () => showLeft("knowledge"),
      },
      {
        id: "view-changes",
        label: "Show Source Control",
        icon: PanelRight,
        category: "View",
        action: () => showRight("changes"),
      },
      {
        id: "view-git-graph",
        label: "Show Git Graph",
        icon: GitBranch,
        category: "View",
        action: () => showRight("git-graph"),
      },

      // ── App ──
      {
        id: "settings",
        label: "Open Settings",
        shortcut: "⌘,",
        icon: Settings,
        category: "App",
        action: () => openTab("settings", "Settings"),
      },
    ],
    [
      addTab,
      toggleLeftPanel,
      toggleRightPanel,
      toggleBottomPanel,
      toggleChatSidebar,
      toggleModelChatSidebar,
      toggleTabBar,
      toggleZenMode,
      toggleUsagePanel,
      setLeftSection,
      setRightSection,
      addGroup,
      focusAdjacentGroup,
      closeGroup,
    ],
  );

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q),
    );
  }, [query, commands]);

  useEffect(() => {
    setSelectedIndex(0);
    setQuery("");
  }, [open]);

  // Keep the keyboard-selected row visible (the list is long once grouped).
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-idx="${selectedIndex}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  function runCommand(cmd: Command) {
    cmd.action();
    onOpenChange(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      runCommand(filtered[selectedIndex]);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed top-[20%] left-1/2 -translate-x-1/2 z-[var(--z-modal)]",
            "w-[520px] max-h-[400px] rounded-xl overflow-hidden",
            "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
            "shadow-[var(--shadow-overlay)]",
            "flex flex-col",
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Run a command</Dialog.Title>
          {/* `shrink-0`: without it the flex column compresses this fixed-height
              search bar when the list overflows `max-h` (the command list is
              long), making it render at half height. */}
          <div className="flex items-center gap-2 px-4 h-[44px] shrink-0 border-b border-[var(--border-default)]">
            <Search
              size={14}
              className="text-[var(--text-tertiary)] shrink-0"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
          </div>

          <div ref={listRef} className="overflow-y-auto flex-1 py-1">
            {filtered.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
                No commands found
              </div>
            )}
            {filtered.map((cmd, i) => {
              const Icon = cmd.icon;
              // Section header before the first item of each category — breaks
              // the long flat list into scannable groups.
              const showHeader =
                i === 0 || filtered[i - 1].category !== cmd.category;
              return (
                <Fragment key={cmd.id}>
                  {showHeader && (
                    <div className="px-4 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)] select-none">
                      {cmd.category}
                    </div>
                  )}
                  <button
                    data-idx={i}
                    onClick={() => runCommand(cmd)}
                    onMouseEnter={() => setSelectedIndex(i)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 h-[36px] text-left text-sm transition-colors",
                      i === selectedIndex
                        ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                        : "text-[var(--text-secondary)]",
                    )}
                  >
                    <Icon
                      size={14}
                      className="shrink-0 text-[var(--text-tertiary)]"
                    />
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {cmd.shortcut && <KbdCombo combo={cmd.shortcut} />}
                  </button>
                </Fragment>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
