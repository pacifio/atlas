import type { ReactNode, Ref } from "react";
import { Copy, Hash, Link2, Play } from "lucide-react";
import {
  AvatarStack,
  HintGroup,
  HintItem,
  type LabelTone,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { INK, presenceLabel } from "../../lib/derive";

export interface DraftPeerView {
  id: string;
  /** The full name; null when the member is not in the roster. */
  name: string | null;
  tone: LabelTone;
  avatar: ReactNode;
}

export interface DraftEditorViewProps {
  convName: string | null;
  sent: boolean;
  ready: boolean;
  /** Where the container mounts CodeMirror. */
  editorHost: Ref<HTMLDivElement>;
  onCopy: () => void;
  onSendToAgent: () => void;
  peers: DraftPeerView[];
  /** Your own avatar, always last in the stack. */
  self: ReactNode;
}

/** How many peers the header shows before it counts the rest. */
const PEERS_SHOWN = 3;

/**
 * The Prompt Draft editor's chrome, drawn from props: the conversation, the
 * action pill, who is here, the sent banner, and the host the container
 * mounts CodeMirror into (`draft-editor.tsx`).
 */
export function DraftEditorView({
  convName,
  sent,
  ready,
  editorHost,
  onCopy,
  onSendToAgent,
  peers,
  self,
}: DraftEditorViewProps) {
  return (
    <div data-view="draft-editor" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border px-1.5">
        <span className="flex min-w-0 items-center gap-1 pl-1 text-xs font-medium text-secondary-foreground">
          <Hash size={11} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{convName ?? "conversation"}</span>
        </span>

        {/* Centre: the grouped action pill. */}
        <div className="flex min-w-0 flex-1 justify-center">
          <HintGroup>
            <div className="flex items-center overflow-hidden rounded-full border border-border bg-element-selected">
              <PillButton label="Copy draft" onClick={onCopy}>
                <Copy size={11} />
              </PillButton>
              <span className="h-4 w-px bg-border" />
              <PillButton label="Send to agent" onClick={onSendToAgent}>
                <Play size={11} />
              </PillButton>
              <span className="h-4 w-px bg-border" />
              {/* No API mints a public draft link (the meetings door is the one
                unauthenticated surface) — a mock, like the Spaces pill. */}
              <PillButton label="Public link — coming soon" disabled>
                <Link2 size={11} />
              </PillButton>
            </div>
          </HintGroup>
        </div>

        {/* Who's here — always at least you: an empty corner read as "nobody
            is in this doc", which is never true while you are. Peers stack in
            front of your avatar as they arrive, each ringed in the hue their
            caret is drawn in. */}
        <div className="flex shrink-0 items-center gap-1.5 pl-1">
          <span role="group" aria-label="In this draft" className="flex items-center">
            <AvatarStack>
              {peers.slice(0, PEERS_SHOWN).map((p) => (
                <Tooltip key={p.id}>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex">
                        <span className={cn("inline-flex rounded-full ring-2", INK[p.tone].ring)}>
                          {p.avatar}
                        </span>
                      </span>
                    }
                  />
                  <TooltipContent side="bottom" sideOffset={4}>
                    {p.name ?? "Unknown"} · editing
                  </TooltipContent>
                </Tooltip>
              ))}
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex">{self}</span>} />
                <TooltipContent side="bottom" sideOffset={4}>
                  You
                </TooltipContent>
              </Tooltip>
            </AvatarStack>
            {peers.length > PEERS_SHOWN && (
              <span className="pl-1 text-2xs text-muted-foreground">
                +{peers.length - PEERS_SHOWN}
              </span>
            )}
          </span>
          {peers.length > 0 && (
            <span className="max-w-40 truncate text-2xs text-muted-foreground">
              {presenceLabel(peers.map((p) => p.name ?? "Unknown"))}
            </span>
          )}
        </div>
      </div>

      {sent && (
        <div className="shrink-0 border-b border-border-subtle bg-element-hover px-3 py-1 text-2xs text-muted-foreground">
          Sent to an agent — this draft is read-only now.
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-y-auto hide-scrollbar">
        {!ready && (
          <div className="flex flex-col gap-2 px-4 py-4">
            <Skeleton className="h-[10px] w-3/5" />
            <Skeleton className="h-[10px] w-1/2" />
            <Skeleton className="h-[10px] w-2/5" />
          </div>
        )}
        <div ref={editorHost} className={cn("h-full [&_.cm-editor]:h-full", !ready && "hidden")} />
      </div>
    </div>
  );
}

function PillButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex h-[22px] w-8 items-center justify-center text-secondary-foreground transition-colors",
          disabled
            ? "cursor-not-allowed text-disabled"
            : "hover:bg-element-active hover:text-foreground cursor-pointer",
        )}
      >
        {children}
      </button>
    </HintItem>
  );
}
