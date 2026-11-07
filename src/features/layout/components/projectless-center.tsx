import { useState, Suspense } from "react";
import { House } from "lucide-react";
import { PaneHeader } from "@/components/titlebar";
import { WelcomeScreen } from "@/features/app/components/welcome-screen";
import { tabNavigationActions } from "@/features/keybindings/lib/navigation-hints";
import { columnChrome } from "../lib/shell-edges";
import { navigationTabs, useLayoutStore, type Tab } from "../stores/layout-store";
import { PaneTab, useTabListFocus } from "./pane-tab";
import { TabContent } from "./tab-panels";
import { PanelLoading } from "./views/panel-loading";

/**
 * The centre with NO project open. The old gate returned a bare
 * `<WelcomeScreen/>` and silently discarded the whole tab system — so an
 * `addTab("comms-draft")` from the chat panel "worked" in the store while
 * nothing could ever render it. Org-scoped surfaces (settings, prompt
 * drafts, spaces when it lands) do not need a project; this shell renders
 * exactly those, with Welcome as an un-closable Home tab, and leaves every
 * other tab untouched in the store for when a project opens.
 */
export function ProjectlessCenter() {
  const tabs = useLayoutStore.use.tabs();
  const activeByGroup = useLayoutStore.use.activeByGroup();
  const focusedGroupId = useLayoutStore.use.focusedGroupId();
  const { setActiveTab } = useLayoutStore.use.actions();
  // The only column: the leftmost and the rightmost.
  const chrome = columnChrome(true, true);
  // Home is LOCAL state, not a store id: `setActiveTab` validates ids and
  // falls back to `tabs[0]` on a miss, so a sentinel id would re-activate
  // the very tab the user clicked away from.
  const [atHome, setAtHome] = useState(false);

  const allowed = navigationTabs(tabs, focusedGroupId, true);
  const storeActive = activeByGroup[focusedGroupId] ?? null;
  const activeIndex = allowed.findIndex((t) => t.id === storeActive);
  const active = atHome ? null : (allowed.find((t) => t.id === storeActive) ?? null);
  // The strip's one Tab stop: the tab focus is on, else the active one.
  const { focusedId, listProps } = useTabListFocus();
  const stopId =
    focusedId !== null && (focusedId === HOME_TAB.id || allowed.some((t) => t.id === focusedId))
      ? focusedId
      : (active?.id ?? HOME_TAB.id);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Always there, even with only Welcome to show: it is where the
        window's own controls (traffic lights, account) sit. */}
      <PaneHeader
        leading={chrome.leading}
        breadcrumb={chrome.breadcrumb}
        trailing={chrome.trailing}
      >
        {allowed.length > 0 && (
          <div
            role="tablist"
            aria-label="Tabs"
            {...listProps}
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto hide-scrollbar"
          >
            {/* Home is a pseudo-tab, not a store tab: it cannot close and it
                is simply "no allowed tab selected". */}
            <PaneTab
              tab={HOME_TAB}
              icon={House}
              active={active === null}
              tabStop={stopId === HOME_TAB.id}
              focused
              running={false}
              onSelect={() => setAtHome(true)}
            />
            {allowed.map((tab, index) => (
              <PaneTab
                key={tab.id}
                tab={tab}
                navigationActions={
                  !atHome ? tabNavigationActions(index, allowed.length, activeIndex) : []
                }
                active={tab.id === active?.id}
                tabStop={stopId === tab.id}
                focused
                running={false}
                onSelect={() => {
                  setAtHome(false);
                  setActiveTab(tab.id);
                }}
              />
            ))}
          </div>
        )}
      </PaneHeader>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<PanelLoading />}>
          {active ? <TabContent key={active.id} tab={active} /> : <WelcomeScreen />}
        </Suspense>
      </div>
    </div>
  );
}

/** The projectless strip's Home pseudo-tab. Typed as a chat tab only so it
 *  can borrow `PaneTab`, which is handed the House icon alongside it. */
const HOME_TAB: Tab = {
  id: "__home",
  type: "chat",
  title: "Home",
  closable: false,
  dirty: false,
  data: {},
};
