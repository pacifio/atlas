import { useEffect, useRef, useState, useMemo, memo } from "react";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useNavigationHint } from "@/features/keybindings/lib/use-navigation-hint";
import { splitNavigationActions } from "@/features/keybindings/lib/navigation-hints";
import { PaneHeader } from "@/components/titlebar";
import { BreadcrumbSeparator } from "@/components/breadcrumb-button";
import { SessionSwitcher } from "@/features/sidebar/components/session-switcher";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { sessionDisplayTitle } from "@/features/chat/lib/session-title";
import { SessionHeaderSlot } from "@/features/chat/components/session-header-slot";
import { Plus, Maximize2, Minimize2 } from "lucide-react";
import { columnChrome } from "../lib/shell-edges";
import { PaneTopInsetContext } from "../lib/pane-top-inset";
import { OPEN_SURFACE_MENU_EVENT, SURFACES, openSurface, surfaceForKey } from "../lib/surfaces";
import { useLayoutStore, type Tab, type ProjectView } from "../stores/layout-store";
import { PaneTabStrip } from "./pane-tab-strip";
import { GROUP_OF } from "./tab-panels";
import { TabContentContainer } from "./tab-content-container";
import {
  HintGroup,
  HintItem,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  IconButton,
} from "@tryatlas/design";

/**
 * One split column. The two roles are deliberately unalike, so it reads at a
 * glance which pane is the work and which holds references beside it:
 *
 * - **main** (the first column): no `+` and no close. With one tab it shows no
 *   strip at all — the tab's title is the breadcrumb's last segment, except an
 *   editor's, which its own crumb row names. A strip appears only once there
 *   is something to switch between. Its right end carries the session's own
 *   controls on a session tab (Details, terminal, ⋯), and on the window's
 *   right edge the window's group (the panel toggle, the account).
 * - **surface**: tabs then `+`, left-aligned; the pane's last column ends in
 *   maximize and the two placement toggles (`PanelPlacementControls`). The
 *   pane is shown and hidden by the window group's panel toggle
 *   (`RightPanelToggle`), never closed with an ×, so hiding it never throws
 *   its tabs into the main pane.
 */
export const TabColumn = memo(function TabColumn({
  groupId,
  role,
  view,
  isActive,
  runningTabIds,
  solo,
  atLeft,
  atRight,
  placementControls,
  projectId,
}: {
  groupId: string;
  role: "main" | "surface";
  view: ProjectView;
  isActive: boolean;
  runningTabIds: Set<string>;
  /** The only column on screen. */
  solo: boolean;
  atLeft: boolean;
  atRight: boolean;
  /** The pane's last column: its strip ends in maximize and the placement
   *  toggles. */
  placementControls: boolean;
  projectId: string;
}) {
  const { setActiveTab, setFocusedGroup, moveTab } = useLayoutStore.use.actions();
  const navigationHint = useNavigationHint();

  const tabsAll = view.tabs;
  const tabs = useMemo(() => tabsAll.filter((t) => GROUP_OF(t) === groupId), [tabsAll, groupId]);
  const activeId = view.activeByGroup[groupId] ?? null;
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const isFocused = isActive && view.focusedGroupId === groupId;
  const chrome = columnChrome(atLeft, atRight);
  const main = role === "main";
  // The main column is the session: it names it in the breadcrumb and never
  // draws a strip. Sessions switch from the sidebar; everything else opens in
  // the surfaces pane, whose strip this is.
  const showStrip = !main;
  // The session column's header floats over the transcript (see
  // `pane-top-inset.ts`); how tall it is, for what has to clear it.
  const headerRef = useRef<HTMLDivElement>(null);
  const topInset = useFloatingHeaderHeight(headerRef, main);

  return (
    <div
      role="group"
      aria-label={`Pane ${view.groupOrder.indexOf(groupId) + 1}`}
      {...navigationHint(
        isActive ? splitNavigationActions(groupId, view.groupOrder, view.focusedGroupId) : [],
      )}
      data-session-column={main || undefined}
      className="relative h-full flex flex-col overflow-hidden bg-background"
      // The notifications drawer sizes itself to the surfaces pane by this.
      data-surface-column={main ? undefined : ""}
      onMouseDownCapture={() => setFocusedGroup(groupId)}
    >
      {/* The column's header, and this column's slice of the window bar: the
          outermost columns carry the window's own controls. In the session
          column it floats, transparent, over the content: the transcript
          scrolls under it and dissolves into the transcript's progressive
          blur instead of being cut off by an opaque strip. */}
      <PaneHeader
        ref={headerRef}
        leading={chrome.leading}
        breadcrumb={main && chrome.breadcrumb}
        trailing={chrome.trailing}
        className={main ? "absolute inset-x-0 top-0 z-titlebar" : undefined}
      >
        {main && chrome.breadcrumb && !showStrip && activeTab && namedInWindowBar(activeTab) && (
          <>
            <BreadcrumbSeparator />
            <MainTitle tab={activeTab} />
          </>
        )}
        <HintGroup>
          {showStrip && (
            // Tabs then `+`, left-aligned together: the `+` sits where the
            // next tab will appear. Only the tabs scroll; the `+` and the
            // controls after it stay put.
            <PaneTabStrip
              tabs={tabs}
              activeId={activeId}
              // With two panes on screen, only the focused one's active tab
              // is fully lit, so it is clear where the next keystroke lands.
              focused={solo || isFocused}
              navigationEnabled={isFocused}
              runningTabIds={runningTabIds}
              onSelect={setActiveTab}
              onMove={moveTab}
            />
          )}
          {/* Never narrower than its controls: when space runs out it is the
              tab strip that gives way and scrolls. */}
          <div className="flex min-w-fit flex-1 items-center gap-0.5">
            {!main && <SurfaceAdd groupId={groupId} />}
            <span className="flex-1" />
            {/* The session's controls (pins, Details), portalled in by its
                chat panel. Only for a session tab: any other tab leaves this
                end of the bar as it is. The window's group (the panel toggle)
                comes after, in the header at the window's right edge
                (`TopbarTrailing`). */}
            {activeTab?.type === "chat" && (
              <SessionHeaderSlot key={activeTab.id} tabId={activeTab.id} />
            )}
            {placementControls && <PanelPlacementControls />}
          </div>
        </HintGroup>
      </PaneHeader>

      <PaneTopInsetContext.Provider value={topInset}>
        <TabContentContainer
          groupId={groupId}
          view={view}
          isActive={isActive}
          projectId={projectId}
        />
      </PaneTopInsetContext.Provider>
    </div>
  );
});

/** The floating header's height, tracked as the interface zoom changes it. 0
 *  while the header is an ordinary row. */
function useFloatingHeaderHeight(ref: React.RefObject<HTMLDivElement | null>, floating: boolean) {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!floating || !el) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(Math.round(el.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, floating]);
  return height;
}

/** Whether the window bar names the main pane's tab after the project. An
 *  editor tab doesn't: its breadcrumb row already ends at the file, with its
 *  icon and unsaved dot, so the bar keeps only the project. */
function namedInWindowBar(tab: Tab): boolean {
  return tab.type !== "editor";
}

/** The main pane's title, the breadcrumb's last segment. A chat names its
 *  session (the chat store is keyed by tab id) rather than the tab's generic
 *  "Agents". It is the one place the session's name shows: the session view
 *  itself does not repeat it. On a session it is also the switch between the
 *  project's sessions, and where a new one starts (`session-switcher.tsx`). */
function MainTitle({ tab }: { tab: Tab }) {
  const sessionTitle = useChatStore((s) => {
    const session = tab.type === "chat" ? s.sessions[tab.id] : undefined;
    return session ? sessionDisplayTitle(session.title, session.firstUserContent) : null;
  });
  if (tab.type === "chat") return <SessionSwitcher title={sessionTitle ?? tab.title} />;
  return (
    <span className="min-w-0 truncate px-1 text-sm text-foreground">
      {sessionTitle ?? tab.title}
    </span>
  );
}

/**
 * The end of the surfaces pane's strip: Maximize, which gives the pane the
 * whole centre (the session collapses, still mounted), so the strip sits at
 * the window's top; again restores it. It is the strip's only control: the
 * pane is shown and hidden by the window group's panel toggle
 * (`RightPanelToggle`), and it always sits on the right.
 */
function PanelPlacementControls() {
  const surfaces = useLayoutStore.use.surfaces();
  const { setSurfaces } = useLayoutStore.use.actions();
  const maximized = surfaces === "expanded";
  const maximizeLabel = maximized ? "Restore panel size" : "Maximize panel";
  return (
    <>
      <HintItem label={maximizeLabel}>
        <IconButton
          icon={maximized ? Minimize2 : Maximize2}
          label={maximizeLabel}
          size="sm"
          iconSize="md"
          aria-pressed={maximized}
          onClick={() => setSurfaces(maximized ? "shown" : "expanded")}
        />
      </HintItem>
    </>
  );
}

/**
 * The surfaces pane's `+`: a menu of the surfaces for this column, each with
 * its letter, which also picks it while the menu is open. `⌘T` opens it once
 * the pane exists (see `tabs.openSurface` in App.tsx).
 */
function SurfaceAdd({ groupId }: { groupId: string }) {
  const hint = useActionShortcut("tabs.openSurface")?.label;
  const label = hint ? `Open a surface (${hint})` : "Open a surface";
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<{ groupId?: string }>).detail?.groupId === groupId) setOpen(true);
    };
    window.addEventListener(OPEN_SURFACE_MENU_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SURFACE_MENU_EVENT, onOpen);
  }, [groupId]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <HintItem label={label}>
        <DropdownMenuTrigger
          render={
            <IconButton
              icon={Plus}
              label="Open a surface"
              size="sm"
              iconSize="md"
              data-tip-anchor="surfaces"
            />
          }
        />
      </HintItem>
      {/* Opens under the `+` with their left edges in line —
          the menu grows out of the button it came from, toward the pane. */}
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-48"
        // Letters pick, before the menu's own typeahead sees them.
        onKeyDownCapture={(e) => {
          const surface = surfaceForKey(e);
          if (!surface) return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          openSurface(surface, groupId);
        }}
      >
        {SURFACES.map((surface) => (
          <DropdownMenuItem key={surface.type} onClick={() => openSurface(surface, groupId)}>
            <surface.icon size={14} />
            {surface.label}
            <DropdownMenuShortcut>{surface.key}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
