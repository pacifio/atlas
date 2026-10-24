import { lazy, Suspense, useState } from "react";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { AppSidebar } from "@/features/sidebar/components/app-sidebar";
import { useProjectGitPrefetch } from "@/features/projects/lib/use-project-prefetch";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { CenterPanel } from "./center-panel";
import { DestinationScreen } from "./destination-screen";

const SettingsScreen = lazy(() =>
  import("@/features/settings/components/settings-screen").then((m) => ({
    default: m.SettingsScreen,
  })),
);

export function AppLayout() {
  // Settings covers the window once opened, and stays mounted (hidden) after,
  // so its open page and drafts survive a trip back to the workspace.
  const settingsOpen = useSettingsNav((s) => s.open);
  const [settingsMounted, setSettingsMounted] = useState(settingsOpen);
  if (settingsOpen && !settingsMounted) setSettingsMounted(true);
  const sidebarOpen = useProjectStore.use.sidebarOpen();

  // Warm the project-pane git data at startup so the first open is smooth.
  useProjectGitPrefetch();

  return (
    <div className="relative flex h-screen w-screen max-w-full overflow-hidden">
      {/* The left sidebar: an in-flow column that pushes the shell right, the
          same as the right-hand panels. It stays open until closed. Full-height
          so it sits beside the titlebar; its own top bar dodges the traffic
          lights. */}
      {sidebarOpen && (
        // The divider's colour is `--atlas-rail-divider`, set on the rail's
        // own class in `globals.css` — see the note there. This is the one
        // edge in the shell with nothing either side of it to read against:
        // the rail sits at `--sidebar` and the content at `--background`,
        // which on an AMOLED theme are ten and zero. The hairline tokens meant
        // to separate a card from the surface it sits on disappear here.
        <div className="atlas-project-rail h-screen w-[244px] shrink-0 border-r">
          <AppSidebar />
        </div>
      )}

      {/*
       * NOT keyed by project: keying forced a full unmount/remount of the
       * whole shell on every switch (rebuilding CodeMirror/xterm/virtualizer)
       * — the dominant switch cost. Instead, `switchTo` swaps Zustand state in
       * place from an in-RAM snapshot (see project-snapshot.ts), so the shell
       * stays mounted and switching is near-instant.
       */}
      {/* `min-w-0` is load-bearing, not decoration. This column is a flex item
          of the row above, so without it its automatic minimum size is its
          MIN-CONTENT width — and min-content propagates up from the deepest
          `whitespace-nowrap` text in any panel (e.g. a 400-char commit subject
          in the git History list). The column then grows PAST the window,
          the split columns' `Group` resolves `width: 100%` against that
          inflated width, and every column scales with it until the last is
          pushed off-screen entirely. `overflow: hidden` on the panels
          does NOT prevent this — it stops a panel's USED size being overridden
          by its content, but the content still contributes to the group's
          intrinsic width. Capping the column here is what keeps the shell
          inside the window no matter what any panel renders. */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        {/* No top bar row: each column's header is its slice of the bar (see
            `columnChrome`). `relative` for the destination, which covers the
            columns while the session runs underneath (ADR-0024). */}
        <div className="relative flex-1 min-h-0">
          <CenterPanel />
          <DestinationScreen />
        </div>
      </div>

      {settingsMounted && (
        <Suspense fallback={null}>
          <SettingsScreen />
        </Suspense>
      )}
    </div>
  );
}
