import * as ContextMenu from "@radix-ui/react-context-menu";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import {
  MessageSquare,
  Terminal,
  Globe,
  BookOpen,
  Settings,
  Copy,
  RefreshCw,
} from "lucide-react";

export function AppContextMenu({ children }: { children: React.ReactNode }) {
  const { addTab } = useLayoutStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="w-[180px] rounded-lg border border-[#1a1a1a] bg-[#0f0f0f] shadow-xl py-1"
          style={{ zIndex: 99999 }}
        >
          {currentProject && (
            <>
              <MenuItem
                icon={<MessageSquare size={12} />}
                label="New Chat"
                shortcut="⌘T"
                onClick={() => openNewAgentChat()}
              />
              <MenuItem
                icon={<Terminal size={12} />}
                label="New Terminal"
                shortcut="⌘⇧T"
                onClick={() =>
                  addTab({
                    id: `terminal-${Date.now()}`,
                    type: "terminal",
                    title: "Terminal",
                    closable: true,
                    dirty: false,
                    data: {},
                  })
                }
              />
              <MenuItem
                icon={<Globe size={12} />}
                label="New Browser"
                onClick={() =>
                  addTab({
                    id: `browser-${Date.now()}`,
                    type: "browser",
                    title: "Browser",
                    closable: true,
                    dirty: false,
                    data: {},
                  })
                }
              />
              <MenuItem
                icon={<BookOpen size={12} />}
                label="Research"
                onClick={() =>
                  addTab({
                    id: `research-${Date.now()}`,
                    type: "research",
                    title: "Research",
                    closable: true,
                    dirty: false,
                    data: {},
                  })
                }
              />
              <ContextMenu.Separator className="h-px bg-[#1a1a1a] my-1" />
            </>
          )}
          <MenuItem
            icon={<Copy size={12} />}
            label="Copy"
            shortcut="⌘C"
            onClick={() => document.execCommand("copy")}
          />
          <ContextMenu.Separator className="h-px bg-[#1a1a1a] my-1" />
          <MenuItem
            icon={<RefreshCw size={12} />}
            label="Reload Window"
            onClick={() => window.location.reload()}
          />
          {currentProject && (
            <MenuItem
              icon={<Settings size={12} />}
              label="Settings"
              shortcut="⌘,"
              onClick={() =>
                addTab({
                  id: "settings",
                  type: "settings",
                  title: "Settings",
                  closable: true,
                  dirty: false,
                  data: {},
                })
              }
            />
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function MenuItem({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <ContextMenu.Item
      onClick={onClick}
      className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none"
    >
      <span className="text-[#555]">{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="text-[9px] text-[#444] font-mono">{shortcut}</span>
      )}
    </ContextMenu.Item>
  );
}
