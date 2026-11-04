import { memo } from "react";
import { useSessionUsage } from "../lib/use-session-usage";
import { ComposerDropup, useComposerDropup } from "./composer-dropup";
import { UsagePillTriggerView } from "./views/usage-pill-view";
import { UsagePopupView } from "./views/usage-popup-view";

/**
 * The Usage pill — the one place a session's consumption is shown, for
 * every agent.
 *
 * Sits first in the composer footer's right cluster (`[Usage] [Options]
 * [Plan]`) as its own right-anchored dropup. The pill itself reads the most
 * useful single number it has: the context window's fill as a percentage
 * with a ring (any agent that reports a gauge), else total tokens (an agent
 * that reports a split but no window), else just "Usage". While the agent
 * compacts its context the pill says so, which is what the native agent's
 * old tok/cost pill used to do.
 *
 * It replaces the status-bar usage widget and the native agent's composer
 * pill, both of which rendered the persisted input/output split and read as
 * "0 tokens · $0.0000" for every ACP session — the protocol never sends
 * that split mid-turn, and the end-of-turn one was dropped before it got
 * here. See `use-session-usage.ts` for what feeds this now.
 */
export const UsagePill = memo(function UsagePill({ tabId }: { tabId: string }) {
  const { open, toggle, ref, contentRef, panelHeight } = useComposerDropup("usage");
  const view = useSessionUsage(tabId, open);

  return (
    <div ref={ref} className="relative">
      <ComposerDropup open={open} panelHeight={panelHeight} contentRef={contentRef}>
        {/* Mounted only while open so the stagger replays and nothing animates
            under a `height: 0` panel. */}
        {open ? <UsagePopupView view={view} /> : null}
      </ComposerDropup>
      <UsagePillTriggerView pill={view.pill} open={open} onToggle={toggle} />
    </div>
  );
});
