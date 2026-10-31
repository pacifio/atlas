// The app's one left sidebar: full height, from the window's top edge to its
// bottom, with the window's corner — traffic lights, dev badge, the sidebar
// toggle — as its top row. Under that, the project picker (the organisation
// sits at the foot of its menu) with Add project beside it, Team chat and
// Timeline, the sessions, and last a dock of icons — Memory, Knowledge, Source
// control, Usage — and the notification bell. Search (the command palette)
// sits in the corner beside the sidebar toggle. The account is the title bar's last
// control (`TopbarTrailing`), not the sidebar's.
//
// Closed, it is gone: no rail of icons stays behind. The corner moves to the
// leftmost column header at the same pixels (`CornerCluster`), so the toggle
// never jumps, and resting on the window's left edge or the toggle peeks the
// sidebar over the session (`SidebarPeek`) for a destination or a session
// without docking it. ⌘K reaches everything here too.
//
// It replaced two columns — the project rail (projects, a recent-sessions
// list, the module navigation) and the session sidebar beside each chat — so
// a session is found in one place whichever project it belongs to. Projects
// are the picker's scope and a badge on each row; Members is in the
// organisation menu (the picker's Organization submenu, and the title bar's
// breadcrumb); Agents is in Settings.
//
// Docking and hiding do not animate: the toggle is a shortcut pressed many
// times a day. Only the peek slides, because it comes and goes under the
// pointer and has to read as laid over the session rather than replacing it.

import { useEffect, useRef } from "react";
import { CornerCluster, useWindowDrag } from "@/components/titlebar";
import { cn } from "@/lib/utils";
import {
  KnowledgeButton,
  MemoryButton,
  NotificationsButton,
  SourceControlButton,
  TeamChatButton,
  TimelineButton,
  UsageButton,
} from "./sidebar-destinations";
import { SidebarProjectPicker } from "./project-picker";
import { SidebarSessions } from "./sidebar-session-list";
import {
  endPeek,
  holdPeek,
  releasePeek,
  requestPeek,
  setPeekPanel,
  useSidebarPeek,
} from "../lib/sidebar-peek";

export function AppSidebar({ className }: { className?: string }) {
  const drag = useWindowDrag();
  return (
    <aside
      className={cn(
        // `atlas-project-rail` is the surface and its divider (globals.css).
        "atlas-project-rail flex h-screen w-full shrink-0 flex-col border-r",
        className,
      )}
    >
      {/* The window's corner. Every stretch of it drags the window. */}
      <div {...drag} className="flex h-titlebar shrink-0 select-none items-center">
        <CornerCluster search />
      </div>
      {/* Room under the corner (traffic lights, toggle, search), so the
          picker reads as the start of the sidebar's content, not part of the
          window's controls. */}
      <div className="px-[8px] pt-[0.35rem]">
        <SidebarProjectPicker />
      </div>
      <div className="mb-2 mt-1">
        <Destinations />
      </div>
      <SidebarSessions />
      <SidebarFoot />
    </aside>
  );
}

/** The labelled destinations: the two views reached most often. */
function Destinations() {
  return (
    <nav aria-label="Destinations" className="flex shrink-0 flex-col items-start gap-0.5 px-[8px]">
      <TeamChatButton />
      <TimelineButton />
    </nav>
  );
}

/** The sidebar's last row: a pill of icons — Memory, the open project's
 *  views (greyed, saying why, with none open), Usage — and the notification
 *  bell at the far end. A short fade
 *  from the sidebar's colour separates the scrolling session list from it. */
function SidebarFoot() {
  return (
    <nav
      aria-label="Sidebar tools"
      className="relative flex shrink-0 items-center gap-0.5 px-[8px] pb-2 pt-1 before:pointer-events-none before:absolute before:inset-x-0 before:-top-4 before:h-4 before:bg-gradient-to-t before:from-sidebar before:to-transparent"
    >
      {/* The pill the title bar's dock used to be: one capsule with a glass
          rim, so the three read as a set rather than three loose glyphs. */}
      <div className="glass-rim flex items-center gap-0.5 rounded-full p-0.5">
        <MemoryButton iconOnly className="rounded-full" />
        <KnowledgeButton iconOnly className="rounded-full" />
        <SourceControlButton iconOnly className="rounded-full" />
        <UsageButton iconOnly className="rounded-full" />
      </div>
      {/* The bell in a capsule of its own, the dock's glass, so the row reads
          as two pieces of one set. */}
      <div className="glass-rim ml-auto flex items-center rounded-full p-0.5">
        <NotificationsButton iconOnly className="rounded-full" />
      </div>
    </nav>
  );
}

/**
 * The closed sidebar: a strip along the window's left edge that peeks it,
 * and the peek itself — the same sidebar, over the session, at the same width
 * and place it docks to. Timing is `sidebar-peek.ts`'s.
 */
export function SidebarPeek() {
  const open = useSidebarPeek.use.open();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPeekPanel(panelRef.current);
    return () => setPeekPanel(null);
  }, [open]);

  // Escape closes it; leaving it open behind a docked sidebar would not.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) endPeek();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Gone with the component: docking the sidebar unmounts this.
  useEffect(() => endPeek, []);

  return (
    <>
      {/* Below the title bar, so it never sits on the traffic lights. */}
      <div
        aria-hidden
        className="absolute bottom-0 left-0 top-[var(--titlebar-height)] z-drawer w-2"
        onPointerEnter={requestPeek}
        onPointerLeave={releasePeek}
      />
      {open && (
        <div
          ref={panelRef}
          className="absolute inset-y-0 left-0 z-drawer w-[244px] shadow-md motion-safe:animate-slide-in-left"
          onPointerEnter={holdPeek}
          onPointerLeave={releasePeek}
        >
          <AppSidebar />
        </div>
      )}
    </>
  );
}
