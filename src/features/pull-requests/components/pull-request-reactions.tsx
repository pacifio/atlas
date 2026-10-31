// Reactions on the pull request or one comment: a pill per reaction (pressed
// when the viewer is among them) and a picker. A press shows at once and is
// rolled back if GitHub refuses it.

import { useState } from "react";
import { toast } from "sonner";
import { SmilePlus } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

import {
  applyPendingReactions,
  REACTION_ORDER,
  reactionEmoji,
  reactionName,
  reactionTooltip,
} from "../lib/pull-request-reactions";
import { usePrReactMutation } from "../lib/pull-requests-queries";
import type { PrReaction, PrReactionContent } from "../lib/pull-requests-types";
import { usePullRequestScope } from "./pull-request-context";
import { AddReactionPill, ReactionPill } from "./pull-request-triggers";

const NO_PENDING: ReadonlyMap<PrReactionContent, boolean> = new Map();

function signatureOf(reactions: readonly PrReaction[]): string {
  return reactions.map((r) => `${r.content}:${r.count}:${r.viewerHasReacted ? 1 : 0}`).join(" ");
}

export function ReactionBar({
  reactions,
  canReact,
  subjectId,
  quietAdd = true,
  className,
}: {
  reactions: readonly PrReaction[];
  canReact: boolean;
  /** The comment; `null` reacts to the pull request itself. */
  subjectId: string | null;
  className?: string;
  /** Keep the add pill visible at rest, where nothing hovers to reveal it. */
  quietAdd?: boolean;
}) {
  const { repoPath, number } = usePullRequestScope();
  const react = usePrReactMutation(repoPath, number);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Presses not yet reflected in a read, keyed to the read they apply over:
  // once a fresh read arrives the overlay is dropped.
  const [pending, setPending] = useState<{
    signature: string;
    values: ReadonlyMap<PrReactionContent, boolean>;
  }>({ signature: "", values: NO_PENDING });
  const signature = signatureOf(reactions);
  const values = pending.signature === signature ? pending.values : NO_PENDING;
  const shown = applyPendingReactions(reactions, values);

  const toggle = (content: PrReactionContent, reacted: boolean) => {
    setPending({ signature, values: new Map([...values, [content, reacted]]) });
    react.mutate(
      { subjectId, content, reacted },
      {
        onError: () => {
          setPending((current) => {
            const next = new Map(current.values);
            next.delete(content);
            return { signature: current.signature, values: next };
          });
          toast.error("The reaction could not be saved");
        },
      },
    );
  };

  if (shown.length === 0 && !canReact) return null;

  return (
    <div className={cn("flex max-w-full min-w-0 flex-wrap items-center gap-1", className)}>
      {shown.map((reaction) => (
        <Tooltip key={reaction.content}>
          <TooltipTrigger
            render={
              <ReactionPill
                reacted={reaction.viewerHasReacted}
                interactive={canReact}
                aria-pressed={reaction.viewerHasReacted}
                aria-label={`${reactionName(reaction.content)}, ${reaction.count}`}
                disabled={!canReact}
                onClick={() => toggle(reaction.content, !reaction.viewerHasReacted)}
              />
            }
          >
            <span aria-hidden>{reactionEmoji(reaction.content)}</span>
            <span className="tabular-nums">{reaction.count}</span>
          </TooltipTrigger>
          <TooltipContent side="top">{reactionTooltip(reaction)}</TooltipContent>
        </Tooltip>
      ))}
      {canReact ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <AddReactionPill quiet={quietAdd && shown.length === 0} aria-label="Add a reaction" />
            }
          >
            <SmilePlus aria-hidden className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-auto p-1">
            <div className="flex items-center gap-0.5">
              {REACTION_ORDER.map((content) => {
                const reacted = shown.find((r) => r.content === content)?.viewerHasReacted ?? false;
                return (
                  <button
                    key={content}
                    type="button"
                    aria-pressed={reacted}
                    aria-label={reactionName(content)}
                    className={cn(
                      "flex size-7 cursor-pointer items-center justify-center rounded text-base hover:bg-element-hover",
                      reacted && "bg-primary-muted",
                    )}
                    onClick={() => {
                      setPickerOpen(false);
                      toggle(content, !reacted);
                    }}
                  >
                    <span aria-hidden>{reactionEmoji(content)}</span>
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
