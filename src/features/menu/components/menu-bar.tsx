import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { HintItem } from "@/ui/hint-group";
import { isActionId } from "@/features/keybindings/lib/actions";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { inWindowMenus, type RunnableItem } from "../lib/menu-model";
import { runMenuItem } from "../lib/run-menu-item";

const MENUS = inWindowMenus();

/**
 * The application menu for Windows and Linux: one button in the sidebar's
 * corner that opens the menus macOS shows in the system menu bar, each as a
 * submenu.
 *
 * Those windows are frameless, so a native Win32/GTK bar would sit under the
 * titlebar as a second strip. It used to be drawn inline instead — `Atlas File
 * Edit View Window Help` across the corner — which crowded the sidebar's top
 * band, pushed the sidebar toggle off its end and clipped `Help`. One button
 * holds the same commands in the space of an icon. The menus are the native
 * macOS menu's (`src-tauri/menu.json`), less the AppKit-only items, so the
 * platforms still list the same commands. macOS never renders this.
 */
export function AppMenuButton({ className }: { className?: string }) {
  return (
    <DropdownMenu>
      <HintItem label="Menu" className={className}>
        <DropdownMenuTrigger
          aria-label="Application menu"
          className={cn(
            "flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none",
            "transition-colors duration-fast ease-out-strong",
            "hover:bg-element-hover hover:text-secondary-foreground",
            "data-[popup-open]:bg-element-selected data-[popup-open]:text-foreground",
            "focus-visible:bg-element-hover",
          )}
        >
          <Menu size={14} aria-hidden />
        </DropdownMenuTrigger>
      </HintItem>
      <DropdownMenuContent align="start" className="min-w-44">
        {MENUS.map((menu) => (
          <DropdownMenuSub key={menu.id}>
            <DropdownMenuSubTrigger>{menu.label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-56">
              {menu.items.map((item, index) =>
                item.type === "separator" ? (
                  <DropdownMenuSeparator key={`sep-${index}`} />
                ) : item.type === "role" ? null : (
                  <MenuItem key={item.id} item={item} />
                ),
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuItem({ item }: { item: RunnableItem }) {
  return (
    <DropdownMenuItem onClick={() => runMenuItem(item.id)}>
      {item.label}
      {item.type === "action" && isActionId(item.id) && <ItemShortcut id={item.id} />}
    </DropdownMenuItem>
  );
}

function ItemShortcut({ id }: { id: Parameters<typeof useActionShortcut>[0] }) {
  const shortcut = useActionShortcut(id);
  return shortcut ? <DropdownMenuShortcut>{shortcut.label}</DropdownMenuShortcut> : null;
}
