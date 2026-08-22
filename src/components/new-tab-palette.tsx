import { useState, useMemo, useRef, useEffect, useLayoutEffect, type ElementType } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Map,
  Terminal,
  Globe,
  Brain,
  Network,
  BrainCircuit,
  ScrollText,
  Code,
  Settings,
  Search,
  GitCompare,
  type LucideProps,
} from "lucide-react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { AtlasIcon } from "@/components/atlas-icon";
import { cn } from "@/lib/utils";
import { KbdCombo } from "@/ui/kbd";
import type { TabType } from "@/lib/constants";

interface ModuleEntry {
  id: string;
  type: TabType;
  label: string;
  icon: ElementType<LucideProps>;
  shortcut?: string;
}

/**
 * Authoritative list of tab modules surfaced in the new-tab palette.
 * Mirrors the `+` dropdown's options but is keyboard-first and
 * filterable. Visual chrome matches `command-palette.tsx` so the two
 * palettes read as one consistent system.
 */
const MODULES: ModuleEntry[] = [
  {
    id: "chat",
    type: "chat",
    label: "New Agents Chat",
    icon: AtlasIcon as ElementType<LucideProps>,
    shortcut: "⌘T",
  },
  { id: "canvas", type: "canvas", label: "Spaces", icon: Map },
  { id: "terminal", type: "terminal", label: "New Terminal", icon: Terminal, shortcut: "⌘⇧T" },
  { id: "knowledge", type: "knowledge", label: "Knowledge", icon: Brain },
  { id: "knowledge-graph", type: "knowledge-graph", label: "Knowledge Graph", icon: Network },
  { id: "memory", type: "memory", label: "Memory", icon: BrainCircuit },
  { id: "diff", type: "diff", label: "Git Diff", icon: GitCompare },
  { id: "browser", type: "browser", label: "Browser", icon: Globe },
  { id: "editor", type: "editor", label: "Untitled Editor", icon: Code, shortcut: "⌘N" },
  { id: "log", type: "log", label: "Log", icon: ScrollText },
  { id: "settings", type: "settings", label: "Settings", icon: Settings, shortcut: "⌘," },
];

export function NewTabPalette({
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
  const { addTab } = useLayoutStore.use.actions();

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MODULES;
    return MODULES.filter(
      (m) => m.label.toLowerCase().includes(q) || m.type.toLowerCase().includes(q),
    );
  }, [query]);

  useEffect(() => {
    if (selectedIndex >= items.length) {
      setSelectedIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, selectedIndex]);

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-idx="${selectedIndex}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const commit = (item: ModuleEntry) => {
    const ts = Date.now();
    if (item.type === "chat") {
      // Singleton agent chat — focus the existing chat tab (resetting it to a
      // fresh session) instead of opening a second one.
      openNewAgentChat();
    } else if (item.type === "editor") {
      addTab({
        id: `editor-untitled-${ts}`,
        type: "editor",
        title: "Untitled",
        closable: true,
        dirty: false,
        data: { filePath: `untitled:${ts}` },
      });
    } else if (item.type === "knowledge-graph") {
      addTab({
        id: "knowledge-graph",
        type: "knowledge-graph",
        title: "Graph",
        closable: true,
        dirty: false,
        data: {},
      });
    } else if (item.type === "settings") {
      addTab({
        id: "settings",
        type: "settings",
        title: "Settings",
        closable: true,
        dirty: false,
        data: {},
      });
    } else {
      addTab({
        id: `${item.type}-${ts}`,
        type: item.type,
        title: item.label,
        closable: true,
        dirty: false,
        data: {},
      });
    }
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[selectedIndex]) {
      e.preventDefault();
      commit(items[selectedIndex]);
    }
  };

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
          <Dialog.Title className="sr-only">Open module</Dialog.Title>
          <div className="flex items-center gap-2 px-4 h-[44px] shrink-0 border-b border-[var(--border-default)]">
            <Search size={14} className="text-[var(--text-tertiary)] shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Open a module..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
          </div>

          <div ref={listRef} className="overflow-y-auto flex-1 py-1">
            {items.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
                No modules match "{query}"
              </div>
            )}
            {items.map((item, i) => {
              const Icon = item.icon;
              const active = i === selectedIndex;
              return (
                <button
                  key={item.id}
                  data-idx={i}
                  onClick={() => commit(item)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 h-[36px] text-left text-sm transition-colors",
                    active
                      ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)]",
                  )}
                >
                  <Icon size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.shortcut && <KbdCombo combo={item.shortcut} />}
                </button>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
