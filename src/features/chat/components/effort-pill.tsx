import { Brain } from "lucide-react";
import { Icon } from "@tryatlas/design";
import { useChatStore } from "../stores/chat-store";
import { composerPillClass, composerPillLabelClass } from "../lib/composer-pill-class";

const EFFORT_CYCLE = ["", "low", "medium", "high", "max"] as const;

/** Reasoning-effort pill for the native agent on Anthropic models (maps to a
 *  thinking budget). Cycles off → low → medium → high → max. Hidden for
 *  providers that don't support a thinking budget. */
export function EffortPill({ tabId }: { tabId: string }) {
  const provider = useChatStore((s) => s.sessions[tabId]?.nativeProvider ?? "");
  const effort = useChatStore((s) => s.sessions[tabId]?.nativeEffort ?? "");
  const { setNativeEffort } = useChatStore.use.actions();
  if (provider !== "anthropic") return null;
  const cycle = () => {
    const i = EFFORT_CYCLE.indexOf(effort as (typeof EFFORT_CYCLE)[number]);
    setNativeEffort(tabId, EFFORT_CYCLE[(i + 1) % EFFORT_CYCLE.length]);
  };
  const active = effort !== "";
  return (
    <button
      type="button"
      onClick={cycle}
      className={composerPillClass(false)}
      title="Reasoning effort (thinking budget) — Anthropic models"
    >
      <Icon icon={Brain} size="sm" className={active ? "text-primary" : "text-muted-foreground"} />
      <span className={composerPillLabelClass("early")}>
        {active ? `Think: ${effort}` : "Think"}
      </span>
    </button>
  );
}
