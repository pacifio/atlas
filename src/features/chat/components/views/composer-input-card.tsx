// The composer's input card: the nested surface holding the editor and the
// send button. Props-only — the editor arrives as `editor`.

import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { ComposerSendButton } from "./composer-send-button";

export function ComposerInputCard({
  cardRef,
  collapsed,
  disabled,
  editor,
  mode,
  stopping,
  enterToSend,
  buttonEnabled,
  onSubmit,
}: {
  cardRef: Ref<HTMLDivElement>;
  collapsed: boolean;
  disabled: boolean;
  editor: ReactNode;
  mode: "send" | "queue" | "stop";
  stopping: boolean;
  enterToSend: boolean;
  buttonEnabled: boolean;
  onSubmit: () => void;
}) {
  return (
    <>
      {/* Inner input surface — nested card with its own border + focus
              glow, sitting proud of the muted shell. The send button lives INSIDE it. */}
      <div
        ref={cardRef}
        className={cn(
          // `min-h-[44px]`: the send button is absolutely positioned 8px
          // from the top at 28px tall, so it needs 36px of field to sit
          // inside. The editor's own min-height (`.atlas-chat-composer`
          // in globals.css) normally provides it; the floor makes the
          // geometry hold before the editor chunk has landed, or with no
          // editor mounted at all.
          // `z-10` so the tray slides up BEHIND it. A capsule while the
          // composer is folded (`rounded-composer`: half the card's 46px),
          // a card while it is open; the corner eases between the two.
          // No bottom margin: the tray hangs straight off its edge.
          // `shadow-sm`: the `md` rung cast onto the tray under it and read
          // as the tray being disabled.
          "relative z-10 mx-1 mt-1 min-h-[44px] border border-[var(--border)] bg-[var(--background)] shadow-sm",
          collapsed ? "rounded-composer" : "rounded-xl",
          "transition-[border-radius,border-color,box-shadow] duration-base ease-out-strong motion-reduce:transition-none",
          // Focus treatment at HALF strength: the full border-focus +
          // /20 accent ring read far too loud on the nested surface.
          "focus-within:border-[color-mix(in_srgb,var(--border-strong)_50%,var(--border))]",
          "focus-within:ring-1 focus-within:ring-[var(--primary)]/10",
          // The disabled dim, scoped to the field the lock actually
          // applies to (see the shell above). No red tint — the send
          // button is already disabled and submit()/Cmd+Enter are gated
          // on `disabled`.
          disabled && "opacity-60",
        )}
      >
        {/* Only the text area is pointer-blocked while `disabled`:
              `pointer-events-none` stops click-to-focus/typing AND the focus
              event, so we never trigger the agent-bind listener against a CLI
              that isn't ready. The toolbar below stays live so the agent /
              model pickers remain reachable. */}
        {/* px padding (not rem — see the send button's geometry note):
                clears the 28px button + 8px inset at any UI scale. */}
        <div className={cn("pr-[40px]", disabled && "pointer-events-none")}>{editor}</div>
        <ComposerSendButton
          mode={mode}
          stopping={stopping}
          enterToSend={enterToSend}
          enabled={buttonEnabled}
          onSubmit={onSubmit}
        />
      </div>
    </>
  );
}
