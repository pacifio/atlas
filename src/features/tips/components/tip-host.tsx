import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle } from "@/ui/popover";
import { StepDots } from "@/components/step-dots";
import { openExternal } from "@/features/feedback/lib/feedback-links";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import { TIPS_CHANGED_EVENT, type TipsState } from "../lib/tips-api";
import { pickNextTip } from "../lib/tip-queue";
import { TIP_BY_ID, type TipDef } from "../lib/tip-registry";
import { useTipsStore } from "../stores/tips-store";

/**
 * Shows Tips (CONTEXT.md, "Tip"). Mounted once per window.
 *
 * Every second while a tip is waiting it gathers what `pickNextTip` needs —
 * which anchors are on screen, whether the user is busy, whether this window
 * is focused — and starts whatever that answers. While a tip shows it checks
 * the anchor is still there, and hands the tip back (unseen) if it is not.
 * Nothing runs while the queue is empty.
 */

const TICK_MS = 1_000;

function onScreen(node: HTMLElement): boolean {
  if (!node.isConnected) return false;
  const r = node.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < window.innerHeight &&
    r.left < window.innerWidth
  );
}

/** The first on-screen element marked `data-tip-anchor="<anchor>"`. */
function findAnchor(anchor: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tip-anchor="${anchor}"]`);
  for (const node of nodes) if (onScreen(node)) return node;
  return null;
}

/** The user is typing: the focused field has text in it. */
function isTyping(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.trim() !== "";
  }
  return el instanceof HTMLElement && el.isContentEditable && (el.textContent ?? "").trim() !== "";
}

function agentTurnRunning(): boolean {
  return Object.values(useChatStore.getState().sessions).some((s) => s.status === "running");
}

export function TipHost() {
  const loaded = useTipsStore.use.loaded();
  const queued = useTipsStore((s) => s.queue.length > 0 || s.forced !== null);
  const active = useTipsStore.use.active();
  const { load, applyRemote, start, anchorLost } = useTipsStore.use.actions();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    void load();
    const off = listen<TipsState>(TIPS_CHANGED_EVENT, (e) => applyRemote(e.payload));
    return () => void off.then((f) => f());
  }, [load, applyRemote]);

  // Waiting: look for a tip to start.
  useEffect(() => {
    if (!loaded || active || !queued) return;
    const tick = () => {
      const s = useTipsStore.getState();
      const id = pickNextTip(
        {
          queue: s.queue,
          forced: s.forced,
          seen: new Set(s.seen),
          cohort: s.cohort,
          enabled: useSettingsStore.getState().settings.showTips,
          now: Date.now(),
          lastShownAt: s.lastShownAt,
          busy: useKeybindingsStore.getState().firstRun || agentTurnRunning() || isTyping(),
          focused: document.hasFocus(),
          anchorVisible: (anchor) => findAnchor(anchor) !== null,
        },
        TIP_BY_ID,
      );
      const tip = id ? TIP_BY_ID[id] : undefined;
      const el = tip ? findAnchor(tip.anchor) : null;
      if (tip && el) {
        setAnchorEl(el);
        start(tip.id, Date.now());
      }
    };
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [loaded, active, queued, start]);

  // Showing: hand the tip back if its anchor leaves the screen.
  useEffect(() => {
    if (!active || !anchorEl) return;
    // The element the card points at, not "an" anchor: with two composers
    // on screen the tip stays on the one it started on.
    const timer = window.setInterval(() => {
      if (!onScreen(anchorEl)) anchorLost();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [active, anchorEl, anchorLost]);

  const tip = active ? TIP_BY_ID[active.id] : undefined;
  if (!active || !tip || !anchorEl) return null;
  return <TipCard tip={tip} step={active.step} anchor={anchorEl} />;
}

function TipCard({ tip, step, anchor }: { tip: TipDef; step: number; anchor: HTMLElement }) {
  const { nextStep, finish } = useTipsStore.use.actions();
  const current = tip.steps[Math.min(step, tip.steps.length - 1)];
  const last = step >= tip.steps.length - 1;

  return (
    <Popover
      open
      // Escape and a click outside close it too, and count as seen: a tip
      // that came back after being waved away would be nagging.
      onOpenChange={(open) => {
        if (!open) void finish("dismissed");
      }}
    >
      <PopoverContent
        anchor={anchor}
        side={tip.side ?? "bottom"}
        // Clears the arrow.
        sideOffset={10}
        arrow
        // The user may be mid-thought in the composer; never take their focus.
        initialFocus={false}
        finalFocus={false}
        data-tip={tip.id}
      >
        <div className="flex flex-col gap-1">
          <PopoverTitle>{current.title}</PopoverTitle>
          <PopoverDescription>{current.body}</PopoverDescription>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <StepDots count={tip.steps.length} step={step} />
          <div className="flex items-center gap-1">
            {tip.learnMore && (
              <Button variant="ghost" size="sm" onClick={() => void openExternal(tip.learnMore!)}>
                Learn more
              </Button>
            )}
            <Button size="sm" onClick={() => (last ? void finish("done") : nextStep())}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
