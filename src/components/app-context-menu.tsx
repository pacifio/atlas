import { ContextMenu } from "@base-ui/react/context-menu";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { ActionId } from "@/features/keybindings/lib/actions";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { MessageSquare, Terminal, Globe, Settings, Copy, RefreshCw } from "lucide-react";

/** `children` is the single element the menu is attached to — Base UI's
 * `render` clones it, the way Radix's `asChild` merged onto it. */
export function AppContextMenu({ children }: { children: React.ReactElement }) {
  const { addTab } = useLayoutStore.use.actions();
  const currentProject = useAppStore.use.currentProject();

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Portal>
        {/* Base UI positions the Popup through a Positioner, and the Popup is
            static inside it — the z-index has to sit on the Positioner or it
            does nothing. */}
        <ContextMenu.Positioner className="z-popover">
          <ContextMenu.Popup className="w-[180px] rounded-lg border border-border-subtle bg-popover shadow-xl py-1">
            {currentProject && (
              <>
                <MenuItem
                  icon={<MessageSquare size={12} />}
                  label="New Session"
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
                <ContextMenu.Separator className="h-px bg-border-subtle my-1" />
              </>
            )}
            <MenuItem
              icon={<Copy size={12} />}
              label="Copy"
              shortcut="⌘C"
              onClick={() => document.execCommand("copy")}
            />
            <ContextMenu.Separator className="h-px bg-border-subtle my-1" />
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
                onClick={() => openSettingsSection()}
              />
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
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
      className="flex items-center gap-2 px-3 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-3xs text-muted-foreground font-mono">{hint}</span>}
    </ContextMenu.Item>
  );
}
