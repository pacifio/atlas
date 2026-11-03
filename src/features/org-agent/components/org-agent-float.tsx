// The floating messenger: a conversation minimised out of the agent's side
// panel, floating over the bottom-right of the window so it stays in reach
// while the panel holds something else (or is closed).
//
// Maximise takes it back to the side panel (where Full screen takes it on to
// the full page); Close puts it away — it goes back to its tab in the panel.
// One at a time: minimising another conversation replaces it.

import { AnimatePresence, motion } from "motion/react";
import { Maximize2, X } from "lucide-react";

import { revealAgentPanel } from "@/features/layout/lib/org-agent";
import { EASE_PANEL } from "@/lib/motion";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { askTitle, useOrgAgentStore } from "../stores/org-agent-store";
import { OrgAgentThread } from "./org-agent-thread";

export function OrgAgentFloat() {
  const floatingId = useOrgAgentStore.use.floatingId();
  const title = useOrgAgentStore((s) => (s.floatingId ? askTitle(s, s.floatingId) : ""));
  const { restoreToPanel, closeFloating } = useOrgAgentStore.use.actions();

  return (
    <AnimatePresence>
      {floatingId && (
        <motion.section
          key={floatingId}
          role="dialog"
          aria-label={title}
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ duration: 0.2, ease: EASE_PANEL }}
          style={{ transformOrigin: "bottom right" }}
          className="absolute right-4 bottom-4 z-drawer flex h-[min(600px,calc(100svh-6rem))] w-[400px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-lg"
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-4">
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
            <HintGroup side="top">
              <span className="flex shrink-0 items-center">
                <HintItem label="Maximise to the side panel">
                  <IconButton
                    icon={Maximize2}
                    label="Maximise to the side panel"
                    size="md"
                    onClick={() => {
                      restoreToPanel(floatingId);
                      revealAgentPanel();
                    }}
                  />
                </HintItem>
                <HintItem label="Close">
                  <IconButton icon={X} label="Close" size="md" onClick={closeFloating} />
                </HintItem>
              </span>
            </HintGroup>
          </header>
          <OrgAgentThread askId={floatingId} size="compact" autoFocus />
        </motion.section>
      )}
    </AnimatePresence>
  );
}
