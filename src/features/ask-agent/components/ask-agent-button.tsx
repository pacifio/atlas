// The two ways into the ask box from a surface.
//
// `AskAgentButton` is the hover affordance: a small "Ask" button that sits in
// a row or beside a line, hidden until the row is hovered or anything in it
// has keyboard focus. Put `ASK_ROW` on the row. It fades (opacity only,
// `duration-fast`), never moves, so a pointer sweeping down a list does not
// make the rows shift.
//
// `FixWithAgentButton` is for anything that shows an error: always visible,
// and it opens the box with "Fix this:" and the error as a chip. In a modal
// that has to close first (the box cannot sit over a modal's backdrop), pass
// `dismiss`: the box then grows from where the button was.

import { MessageSquarePlus, Sparkles } from "lucide-react";
import { Button, IconButton, Icon } from "@tryatlas/design";

import { cn } from "@/lib/utils";
import type { AgentContext, ErrorContext } from "../lib/agent-context";
import { openAskAgent } from "../lib/ask-agent";

/** The class a row carries so its `AskAgentButton` shows on hover and focus. */
export const ASK_ROW = "group/ask";

export function AskAgentButton({
  context,
  prompt,
  suggestions,
  label = "Ask agent",
  className,
}: {
  context: readonly AgentContext[];
  prompt?: string;
  /** Quick prompts the box offers ("Explain this change"). */
  suggestions?: readonly string[];
  label?: string;
  className?: string;
}) {
  // The reveal lives on a wrapper: the button's own look is the primitive's.
  return (
    <span
      className={cn(
        "inline-flex opacity-0 transition-opacity duration-fast focus-within:opacity-100",
        "group-hover/ask:opacity-100 group-focus-within/ask:opacity-100",
        className,
      )}
    >
      <IconButton
        icon={MessageSquarePlus}
        label={label}
        title={label}
        size="xs"
        variant="ghost"
        onClick={(e) => openAskAgent({ context, prompt, suggestions, anchor: e.currentTarget })}
      />
    </span>
  );
}

export function FixWithAgentButton({
  error,
  dismiss,
  size = "sm",
}: {
  error: ErrorContext;
  /** Close the modal this sits in before the box opens. */
  dismiss?: () => void;
  size?: "xs" | "sm" | "md";
}) {
  return (
    <Button
      size={size}
      variant="ghost"
      onClick={(e) => {
        const button = e.currentTarget;
        const anchor = dismiss ? button.getBoundingClientRect() : button;
        dismiss?.();
        openAskAgent({ context: [error], prompt: "Fix this: ", anchor });
      }}
    >
      <Icon icon={Sparkles} size="sm" />
      Fix with agent
    </Button>
  );
}
