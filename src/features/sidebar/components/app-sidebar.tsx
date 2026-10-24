// The app's one left sidebar: the project picker on top (the organisation
// sits at the foot of its menu), then every session in its projects, then the
// destinations.
//
// It replaced two columns — the project rail (projects, a recent-sessions
// list, the module navigation) and the session sidebar beside each chat — so
// a session is found in one place whichever project it belongs to. Projects
// are the picker's scope and a badge on each row; the destinations are the
// footer's icons; Members is in the organisation menu (the picker's
// Organization submenu, and the title bar's breadcrumb); Agents is in
// Settings.

import { DevBadge } from "@/components/titlebar";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { SidebarFooter } from "./sidebar-footer";
import { SidebarSessions } from "./sidebar-session-list";

export function AppSidebar() {
  const fullscreen = useFullscreen();
  return (
    <aside
      // Transparent — the rail's surface (`atlas-project-rail`) lives on the
      // wrapper in app-layout.tsx.
      className="flex h-screen w-full shrink-0 flex-col bg-transparent"
      data-tauri-drag-region
    >
      {/* Titlebar band: on macOS the traffic lights live here, so the dev
       *  badge clears them (it sits left in fullscreen, where the lights are
       *  gone, and on other platforms, which never have them). */}
      <div
        className={cn(
          "flex h-titlebar shrink-0 items-center gap-0.5 px-2",
          fullscreen || !isMac ? "justify-start" : "justify-end",
        )}
        data-tauri-drag-region
      >
        <DevBadge
          className={cn("mr-auto", !fullscreen && isMac && "ml-[calc(70px/var(--ui-zoom,1))]")}
        />
      </div>

      <SidebarSessions />
      <SidebarFooter />
    </aside>
  );
}
