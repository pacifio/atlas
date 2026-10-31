import { useState, type ElementType } from "react";
import {
  Map,
  Terminal,
  Globe,
  Brain,
  Network,
  BrainCircuit,
  ScrollText,
  Gauge,
  Code,
  type LucideProps,
} from "lucide-react";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { AtlasIcon } from "@/components/atlas-icon";
import { CommandDialog, CommandDialogPopup } from "@/ui/command";
import { CommandPaletteContent } from "@/features/command-palette/components/command-palette-content";
import { filterCommandPaletteGroups } from "@/features/command-palette/lib/command-palette-logic";
import type {
  CommandPaletteActionItem,
  CommandPaletteEntry,
} from "@/features/command-palette/lib/command-palette-logic";
import type { TabType } from "@/lib/constants";

interface ModuleEntry {
  id: string;
  type: TabType;
  label: string;
  icon: ElementType<LucideProps>;
  actionId?: ActionId;
}

/**
 * Authoritative list of tab modules surfaced in the new-tab palette (⌘⌥N).
 * Mirrors the `+` dropdown's options but is keyboard-first and filterable.
 * It renders in the same command shell as ⌘K and ⌘P, so the three read as
 * one system.
 */
const MODULES: ModuleEntry[] = [
  {
    id: "chat",
    type: "chat",
    label: "New Session",
    icon: AtlasIcon as ElementType<LucideProps>,
    actionId: "tabs.newChat",
  },
  { id: "canvas", type: "canvas", label: "Spaces", icon: Map },
  {
    id: "terminal",
    type: "terminal",
    label: "New Terminal",
    icon: Terminal,
    actionId: "tabs.newTerminal",
  },
  { id: "knowledge", type: "knowledge", label: "Knowledge", icon: Brain },
  { id: "knowledge-graph", type: "knowledge-graph", label: "Knowledge Graph", icon: Network },
  { id: "memory", type: "memory", label: "Memory", icon: BrainCircuit },
  { id: "browser", type: "browser", label: "Browser", icon: Globe },
  {
    id: "editor",
    type: "editor",
    label: "Untitled Editor",
    icon: Code,
    actionId: "tabs.newUntitled",
  },
  { id: "log", type: "log", label: "Log", icon: ScrollText },
  { id: "usage", type: "usage", label: "Usage", icon: Gauge, actionId: "usage.open" },
];

function commit(item: ModuleEntry): void {
  const { addTab } = useLayoutStore.getState().actions;
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
}

const ITEMS: CommandPaletteActionItem[] = MODULES.map((module) => {
  const Glyph = module.icon;
  return {
    kind: "action",
    value: module.id,
    title: module.label,
    searchTerms: [module.label, module.type],
    icon: <Glyph size={16} strokeWidth={1.75} />,
    ...(module.actionId ? { shortcutAction: module.actionId } : {}),
    run: () => commit(module),
  };
});

export function NewTabPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup title="Open module">
        <NewTabPaletteContent onClose={() => onOpenChange(false)} />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

/** Mounted per opening, so each one starts on an empty query. */
function NewTabPaletteContent({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const groups = filterCommandPaletteGroups({
    activeGroups: [{ value: "modules", label: "Modules", items: ITEMS }],
    query,
    isInSubmenu: true,
    projectSearchItems: [],
    sessionSearchItems: [],
  });
  const execute = (item: CommandPaletteEntry) => {
    if (item.kind !== "action") return;
    onClose();
    void item.run();
  };
  return (
    <CommandPaletteContent
      groups={groups}
      query={query}
      onQueryChange={setQuery}
      onExecute={execute}
      placeholder="Open a module…"
      emptyMessage={`No modules match “${query}”`}
      footerActionLabel="Open"
      testId="new-tab-palette"
    />
  );
}
