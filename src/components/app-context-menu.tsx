import * as ContextMenu from "@radix-ui/react-context-menu";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { MessageSquare, Terminal, Globe, Settings, Copy, RefreshCw } from "lucide-react";

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
                actionId="tabs.newChat"
                onClick={() => openNewAgentChat()}
              />
              <MenuItem
                icon={<Terminal size={12} />}
                label="New Terminal"
                actionId="tabs.newTerminal"
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
              actionId="app.settings"
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
  actionId,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  /** A literal hint (native shortcuts like ⌘C that Atlas doesn't own). */
  shortcut?: string;
  /** A registry action — the hint follows the active keybinding profile. */
  actionId?: ActionId;
  onClick: () => void;
}) {
  const bound = useActionShortcut(actionId ?? "app.settings");
  const hint = actionId ? bound?.label : shortcut;
  return (
    <ContextMenu.Item
      onClick={onClick}
      className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none"
    >
      <span className="text-[#555]">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[9px] text-[#444] font-mono">{hint}</span>}
    </ContextMenu.Item>
  );
}
