import { useState, useMemo, useRef, useEffect, useLayoutEffect, Fragment } from "react";
import { ActionKbd } from "@/features/keybindings/components/action-kbd";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { AtlasIcon } from "@/components/atlas-icon";
import {
  Globe,
  Terminal,
  Settings,
  PanelLeft,
  PanelRight,
  MessageSquare,
  PanelTop,
  Map,
  Sidebar,
  Columns2,
  Maximize2,
  Network,
  BrainCircuit,
  ScrollText,
  Gauge,
  Code,
  GitBranch,
  ArrowLeftToLine,
  ArrowRightToLine,
  Brain,
  Search,
  FolderOpen,
  Circle,
} from "lucide-react";
import type { TabType } from "@/lib/constants";

interface Command {
  id: string;
  label: string;
  actionId?: ActionId;
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
    toggleRightChatPanel,
    toggleChatSidebar,
    toggleTabBar,
    toggleZenMode,
    setLeftSection,
    setRightSection,
    addGroup,
    focusAdjacentGroup,
    closeGroup,
  } = useLayoutStore.use.actions();
  const { openProject } = useAppStore.use.actions();

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
    "usage",
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
        actionId: "tabs.newChat",
        icon: AtlasIcon,
        category: "Open",
        action: () => openTab("chat", "Agents"),
      },
      {
        id: "new-canvas",
        label: "New Spaces",
        icon: Map,
        category: "Open",
        action: () => openTab("canvas", "Spaces"),
      },
      {
        id: "new-terminal",
        label: "New Terminal",
        actionId: "tabs.newTerminal",
        icon: Terminal,
        category: "Open",
        action: () => openTab("terminal", "Terminal"),
      },
      {
        id: "new-editor",
        label: "New Untitled Editor",
        actionId: "tabs.newUntitled",
        icon: Code,
        category: "Open",
        action: () => openTab("editor", "Untitled"),
      },
      {
        id: "new-browser",
        label: "Open Browser",
        icon: Globe,
        category: "Open",
        action: () => openTab("browser", "Browser"),
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
        id: "new-usage",
        label: "Usage",
        actionId: "usage.open",
        icon: Gauge,
        category: "Open",
        action: () => openTab("usage", "Usage"),
      },

      // ── Layout toggles ──
      {
        id: "toggle-left",
        label: "Toggle Left Panel",
        actionId: "panels.left",
        icon: PanelLeft,
        category: "Layout",
        action: toggleLeftPanel,
      },
      {
        id: "toggle-right",
        label: "Toggle Source Control Panel",
        actionId: "panels.right",
        icon: PanelRight,
        category: "Layout",
        action: toggleRightPanel,
      },
      {
        id: "toggle-right-chat",
        label: "Toggle Team Chat Panel",
        actionId: "panels.teamChat",
        icon: MessageSquare,
        category: "Layout",
        action: toggleRightChatPanel,
      },
      {
        id: "toggle-chat-sidebar",
        label: "Toggle Chat Sidebar",
        actionId: "panels.agentSidebar",
        icon: Sidebar,
        category: "Layout",
        action: toggleChatSidebar,
      },
      {
        id: "toggle-tab-bar",
        label: "Toggle Tab Bar",
        actionId: "panels.tabBar",
        icon: PanelTop,
        category: "Layout",
        action: toggleTabBar,
      },
      {
        id: "toggle-zen",
        label: "Toggle Zen Mode",
        actionId: "panels.zen",
        icon: Maximize2,
        category: "Layout",
        action: toggleZenMode,
      },

      // ── Splits ──
      {
        id: "split-new",
        label: "Split: New Column",
        actionId: "split.new",
        icon: Columns2,
        category: "Split",
        action: () => addGroup(),
      },
      {
        id: "split-focus-left",
        label: "Split: Focus Left",
        actionId: "split.focusLeft",
        icon: ArrowLeftToLine,
        category: "Split",
        action: () => focusAdjacentGroup(-1),
      },
      {
        id: "split-focus-right",
        label: "Split: Focus Right",
        actionId: "split.focusRight",
        icon: ArrowRightToLine,
        category: "Split",
        action: () => focusAdjacentGroup(1),
      },
      {
        id: "split-close",
        label: "Split: Close Column",
        actionId: "split.close",
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
        actionId: "app.settings",
        icon: Settings,
        category: "App",
        action: () => openTab("settings", "Settings"),
      },
      {
        id: "open-capture",
        label: "Open Session Capture",
        actionId: "app.capture",
        icon: Circle,
        category: "App",
        action: () => window.dispatchEvent(new CustomEvent("atlas:open-capture")),
      },
    ],
    [
      addTab,
      toggleLeftPanel,
      toggleRightPanel,
      toggleRightChatPanel,
      toggleChatSidebar,
      toggleTabBar,
      toggleZenMode,
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
      (c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q),
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
        <Dialog.Backdrop className="fixed inset-0 scrim z-overlay" />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed top-[20%] left-1/2 -translate-x-1/2 z-modal",
            "w-[520px] max-h-[400px] rounded-xl overflow-hidden",
            "bg-[var(--card)] border border-[var(--border)]",
            "shadow-md",
            "flex flex-col",
          )}
          // Base UI's initialFocus replaces Radix's onOpenAutoFocus +
          // preventDefault + focus(): hand it the element to land on.
          initialFocus={inputRef}
        >
          <Dialog.Title className="sr-only">Run a command</Dialog.Title>
          {/* `shrink-0`: without it the flex column compresses this fixed-height
              search bar when the list overflows `max-h` (the command list is
              long), making it render at half height. */}
          <div className="flex items-center gap-2 px-4 h-[44px] shrink-0 border-b border-[var(--border)]">
            <Search size={14} className="text-[var(--muted-foreground)] shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
            />
          </div>

          <div ref={listRef} className="overflow-y-auto flex-1 py-1">
            {filtered.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
                No commands found
              </div>
            )}
            {filtered.map((cmd, i) => {
              const Icon = cmd.icon;
              // Section header before the first item of each category — breaks
              // the long flat list into scannable groups.
              const showHeader = i === 0 || filtered[i - 1].category !== cmd.category;
              return (
                <Fragment key={cmd.id}>
                  {showHeader && (
                    <div className="px-4 pt-2.5 pb-1 text-2xs font-medium uppercase tracking-wider text-[var(--muted-foreground)] select-none">
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
                        ? "bg-[var(--atlas-element-hover)] text-[var(--foreground)]"
                        : "text-[var(--secondary-foreground)]",
                    )}
                  >
                    <Icon size={14} className="shrink-0 text-[var(--muted-foreground)]" />
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {cmd.actionId && <ActionKbd id={cmd.actionId} />}
                  </button>
                </Fragment>
              );
            })}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
