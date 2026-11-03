import { Brain } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { composerPillLabelClass } from "./composer-dropup";

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
      onClick={cycle}
      className="flex items-center px-2 h-6.5 rounded-full border border-[var(--border)] bg-[var(--card)] text-2xs leading-none font-medium text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
      title="Reasoning effort (thinking budget) — Anthropic models"
    >
      <Brain
        size={11}
        className={active ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}
      />
      <span className={composerPillLabelClass("early")}>
        {active ? `Think: ${effort}` : "Think"}
      </span>
    </button>
  );
}
