import { useEffect, useRef, useState, useMemo, memo, Suspense } from "react";
import { useLayoutStore, type ProjectView } from "../stores/layout-store";
import { ChatPanel } from "@/features/chat/components/chat-panel";
import { FileDockColumn } from "@/features/explorer/components/file-dock";
import {
  GROUP_OF,
  IDLE_EXPENSIVE_TYPES,
  PERSISTENT_TYPES,
  PersistentPanel,
  TabContent,
  type PersistentTab,
} from "./tab-panels";
import { SurfaceLauncher } from "./surface-launcher";
import { PanelLoading } from "./views/panel-loading";

export const TabContentContainer = memo(function TabContentContainer({
  groupId,
  view,
  isActive,
  projectId,
}: {
  groupId: string;
  view: ProjectView;
  isActive: boolean;
  /** Handed to terminal tabs so they can record their owner. */
  projectId: string;
}) {
  const { setActiveTab } = useLayoutStore.use.actions();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  const tabsAll = view.tabs;
  const tabs = useMemo(() => tabsAll.filter((t) => GROUP_OF(t) === groupId), [tabsAll, groupId]);
  const activeTabId = view.activeByGroup[groupId] ?? null;
  const activeTab = tabs.find((t) => t.id === activeTabId);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setHeight(Math.floor(h));
    };
    measure();
    requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // If this column's active id is stale (closed tab, etc.) snap to its first.
  // Only for the ACTIVE project — `setActiveTab` mutates the live (active)
  // store, so a background project must not fire it.
  useEffect(() => {
    if (isActive && !activeTab && tabs.length > 0) setActiveTab(tabs[0].id);
  }, [isActive, activeTab, tabs, setActiveTab]);

  // Hidden chat tabs stay LAID OUT (`visibility:hidden`, see the wrapper
  // below) — but only once this column has been active for an idle slice.
  // Flipping every mounted chat from `display:none` to laid-out costs one
  // layout per thread, and doing that on app boot or in the same frame as a
  // project switch (background projects are `display:none`) would move
  // the stall we are removing onto those paths instead.
  const [warmReady, setWarmReady] = useState(false);
  useEffect(() => {
    if (!isActive) {
      setWarmReady(false);
      return;
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    let idle: number | null = null;
    let timer: number | null = null;
    const warm = () => {
      idle = null;
      timer = null;
      setWarmReady(true);
    };
    if (typeof w.requestIdleCallback === "function") {
      idle = w.requestIdleCallback(warm, { timeout: 2000 });
    } else {
      timer = window.setTimeout(warm, 150);
    }
    return () => {
      if (idle !== null) w.cancelIdleCallback?.(idle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isActive]);
  const warmChats = isActive && warmReady;

  // An empty column offers what it can hold.
  if (tabs.length === 0) {
    return (
      <div ref={ref} style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden" }}>
        <SurfaceLauncher
          groupId={groupId}
          focused={isActive && view.focusedGroupId === groupId}
          closable={view.groupOrder.length > 1}
        />
      </div>
    );
  }

  if (!activeTab) {
    return <div ref={ref} style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden" }} />;
  }

  // Persist expensive tabs across tab switches within this column. For a
  // BACKGROUND project we additionally drop the types that keep working while
  // hidden (see IDLE_EXPENSIVE_TYPES) — off-screen terminals/browser embeds/
  // graphs were a major source of idle heat. Chat/knowledge/settings stay
  // mounted even in background projects: unmounting chat re-ran the whole
  // transcript-load path (window fill, markdown settle, anchor) on every
  // switch back, and settings lost its form drafts.
  //
  // HOW a hidden tab is hidden matters. Most types use `display:none`. Chat
  // does not: its transcript is real DOM for the whole thread (thousands of
  // laid-out rows for a long session — see `transcript.tsx`, deliberately not
  // virtualized), and `display:none` throws that layout away. Showing the tab
  // again then rebuilt the render tree and laid out every row on the switch
  // frame: a stall proportional to thread length, while an empty chat switched
  // instantly. So a hidden chat keeps its box: `visibility:hidden` skips paint
  // but keeps layout (and the scroller's `scrollTop`), and `inert` takes the
  // subtree out of focus, hit-testing and find. Same contract the terminal
  // uses for its inactive panes. The active chat wrapper is the same absolute
  // box, so toggling a sibling's mode never relayouts the visible thread.
  // The explicit predicate is load-bearing: `Set.has` does not narrow, and
  // `PersistentPanel` below relies on `tab.type` being the `PersistentTabType`
  // union for its exhaustiveness check.
  //
  // Mounted in id order, not strip order. Dragging a tab to a new place in the
  // strip must not move its panel's DOM: React reorders keyed siblings with
  // `insertBefore`, and moving an iframe reloads it. Id order never changes
  // for the tabs already open, so a reorder touches nothing here.
  const persistentTabs = tabs
    .filter(
      (t): t is PersistentTab =>
        PERSISTENT_TYPES.has(t.type) && (isActive || !IDLE_EXPENSIVE_TYPES.has(t.type)),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const activeIsNonPersistent = !persistentTabs.find((t) => t.id === activeTab.id);

  // `@container`: the column's width is what the docked file tree and the
  // room a file leaves for it are measured against (`FILE_DOCK_WIDTH`).
  return (
    <div
      ref={ref}
      className="@container"
      style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden", position: "relative" }}
    >
      <FileDockColumn
        projectId={projectId}
        projectActive={isActive}
        tabs={tabs}
        activeTab={activeTab}
      >
        <Suspense fallback={<PanelLoading />}>
          {persistentTabs.map((tab) => {
            const isActive = tab.id === activeTab.id;
            if (tab.type === "chat") {
              // Until the column has been active for an idle slice, hidden chats
              // fall back to `display:none` (see `warmReady`).
              const hidden = !isActive;
              return (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  inert={hidden}
                  // Pauses the session's working shimmers while it is hidden
                  // (`src/lib/visible-animation.ts`): `visibility:hidden` does
                  // not stop CSS animations the way `display:none` does.
                  data-atlas-offstage={hidden || undefined}
                  style={{
                    display: hidden && !warmChats ? "none" : undefined,
                    visibility: hidden ? "hidden" : "visible",
                    // `visibility` alone is not enough. Anything inside that
                    // WebKit has promoted to its own compositing layer keeps
                    // painting for ~100ms after the ancestor is hidden, and this
                    // wrapper is positioned, so those leftovers land ON TOP of
                    // the tab you just switched to. Ancestor opacity is applied
                    // when the layer is composited, so a stale layer cannot
                    // survive it. Free: opacity is not a layout or paint input.
                    opacity: hidden ? 0 : 1,
                    pointerEvents: hidden ? "none" : "auto",
                    zIndex: hidden ? 0 : 1,
                    contain: "layout style",
                  }}
                >
                  <ChatPanel tabId={tab.id} />
                </div>
              );
            }
            if (tab.type === "terminal") {
              // The chat's contract (above), minus the warm-up: a hidden terminal
              // keeps its box. Under `display:none` WebKit dropped the render
              // tree of every block and line, and showing the tab rebuilt all of
              // it on the switch frame — the near-freeze when switching to a
              // terminal that had been busy. Its sessions stop rendering while
              // hidden anyway (`useIsTabVisible`), so the kept box costs nothing
              // per frame.
              const hidden = !isActive;
              return (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  inert={hidden}
                  style={{
                    visibility: hidden ? "hidden" : "visible",
                    opacity: hidden ? 0 : 1,
                    pointerEvents: hidden ? "none" : "auto",
                    zIndex: hidden ? 0 : 1,
                    contain: "layout style",
                  }}
                >
                  <PersistentPanel tab={tab} projectId={projectId} height={height} />
                </div>
              );
            }
            return (
              <div key={tab.id} style={{ display: isActive ? "contents" : "none" }}>
                <PersistentPanel tab={tab} projectId={projectId} height={height} />
              </div>
            );
          })}

          {/* Keyed by tab id: two tabs of one type (two drafts, two diffs) sit in
            the same slot here, and without a key React reuses the first tab's
            component — and its state — for the second. Two draft tabs shared
            one Y.Doc that way and wrote each other's content. */}
          {activeIsNonPersistent && (
            <TabContent key={activeTab.id} tab={activeTab} projectId={projectId} />
          )}
        </Suspense>
      </FileDockColumn>
    </div>
  );
});
