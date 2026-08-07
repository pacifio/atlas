import { UsageBar } from "@/features/monitor/components/usage-bar";
import { BranchPopover } from "./branch-popover";
import { StatusBarTimer } from "@/features/pomodoro/components/status-bar-timer";
import { FeedbackButton } from "@/features/feedback/components/feedback-button";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

export function StatusBar() {
  const tabs = useLayoutStore.use.tabs();
  const activeTabId = useLayoutStore.use.activeTabId();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const showUsage = activeTab?.type === "chat";

  return (
    <div
      className="h-7 flex items-center justify-between px-3 shrink-0 bg-[#000] border-t border-border-default text-[11px] font-mono text-[#555] select-none relative"
      style={{ zIndex: "var(--z-max)" as unknown as number }}
    >
      <div className="flex items-center gap-3">
        <BranchPopover />
      </div>
      <div className="flex items-center gap-3">
        {showUsage && (
          <>
            <UsageBar />
            <div className="w-px h-3 bg-border-default" aria-hidden />
          </>
        )}
        <StatusBarTimer />
        <div className="w-px h-3 bg-border-default" aria-hidden />
        <FeedbackButton />
      </div>
    </div>
  );
}
