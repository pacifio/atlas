// The composer's tri-state send / queue / stop button. Props-only.

import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";

export function ComposerSendButton({
  mode,
  stopping,
  enterToSend,
  enabled,
  onSubmit,
}: {
  mode: "send" | "queue" | "stop";
  stopping: boolean;
  enterToSend: boolean;
  enabled: boolean;
  onSubmit: () => void;
}) {
  return (
    <>
      {/* No wrapping span: it would sit in flow and misplace this absolute button. */}
      <Hint
        side="top"
        wrap={false}
        label={
          mode === "stop"
            ? stopping
              ? "Stopping… (waiting for the agent to wind down)"
              : "Stop generation"
            : mode === "queue"
              ? "Queue message (sends after current finishes)"
              : "Send to agent"
        }
        shortcut={mode === "send" ? (enterToSend ? "↵" : "⌘↵") : undefined}
      >
        <button
          onClick={onSubmit}
          disabled={!enabled}
          aria-label={
            mode === "stop"
              ? "Stop generation"
              : mode === "queue"
                ? "Queue message"
                : "Send message"
          }
          className={cn(
            // Reference-style squircle send: a soft rounded-square,
            // transparent at rest, muted fill + border on hover, pinned
            // top-right of the input surface (it does not ride down as
            // the field grows).
            // Geometry IN PX, not rem: Atlas's UI-scale setting shrinks
            // the root font-size, so rem utilities (w-7/top-2 → 23px/6.5px
            // under scale) drift against the editor's hardcoded 12px/16px
            // padding — the ruler-measured misalignment. The first text
            // line centers at 12px pad + ~10px half-line = 22px; a 28px
            // button at 8px top centers at 22px at EVERY UI scale.
            "absolute top-[8px] right-[8px] flex items-center justify-center w-[28px] h-[28px] rounded-lg border transition-colors",
            enabled
              ? "border-transparent text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)] hover:border-[var(--border)] cursor-pointer"
              : "border-transparent text-[var(--muted-foreground)] cursor-not-allowed",
          )}
        >
          {/* Updates in place: Enter sends, so the arrow↔stop swap is
                keyboard-driven and has no animation. */}
          <span className="flex items-center justify-center">
            {mode === "stop" ? (
              <Square
                size={11}
                strokeWidth={3}
                fill="currentColor"
                className={stopping ? "animate-pulse" : undefined}
              />
            ) : (
              <ArrowUp size={15} strokeWidth={2.5} />
            )}
          </span>
        </button>
      </Hint>
    </>
  );
}
