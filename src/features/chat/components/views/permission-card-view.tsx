// The inline permission card: what the agent wants to do, its preview, the
// numbered options, and the "tell the agent what to do instead" field.
//
// Props only. The container (`permission-modal.tsx`) reads the queue, answers
// on the wire, and owns the window keydown handler that maps digits, Enter and
// Esc onto these options — that handler is the card's safety logic, so it
// stays with the data, not here. The card takes no focus when it appears: the
// composer keeps it.

import type { Ref } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button, Icon, Kbd, Spinner, Textarea } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { CONTENT_COLUMN } from "../../lib/row-metrics";
import type {
  OutwardApproval,
  OutwardPreparing,
} from "@/features/org-actions/lib/outward-approval";

/** One option as the card draws it: the wire's option, already relabelled. */
export interface PermissionOptionItem {
  optionId: string;
  label: string;
  tone: "allow" | "reject" | "other";
  /** The option Enter picks. Never set on an outward action's card. */
  isPrimary: boolean;
}

export type PermissionCardHeading =
  | { kind: "tool"; title: string }
  | { kind: "outward"; approval: OutwardApproval }
  | { kind: "preparing"; preparing: OutwardPreparing };

export function PermissionCardView({
  heading,
  preview,
  options,
  queueNote,
  draft,
  onDraftChange,
  onSubmitDraft,
  draftRef,
  onSelect,
}: {
  heading: PermissionCardHeading;
  /** The tool call's input as formatted text, or null for none. Ignored on an
   *  outward card, which shows the words it will post instead. */
  preview: string | null;
  options: PermissionOptionItem[];
  queueNote: string | null;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmitDraft: () => void;
  draftRef: Ref<HTMLTextAreaElement>;
  onSelect: (optionId: string) => void;
}) {
  return (
    <div className={cn(CONTENT_COLUMN, "pt-2")}>
      <div
        data-testid="permission-card"
        // A card resting in the composer stack, flat on its border like the
        // composer below it: no elevation, so it reads as part of the stack
        // rather than a menu floating over the transcript.
        className="w-full overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex items-start gap-2 px-3 pt-3">
          <div className="min-w-0 flex-1">
            {heading.kind === "preparing" ? (
              <OutwardPreparingHeading preparing={heading.preparing} />
            ) : heading.kind === "outward" ? (
              <OutwardActionHeading approval={heading.approval} />
            ) : (
              <div className="text-base font-medium leading-snug text-foreground">
                The agent wants to run{" "}
                <span className="font-mono text-foreground">{heading.title}</span>?
              </div>
            )}
            {queueNote && (
              <div className="mt-0.5 text-xs text-secondary-foreground">{queueNote}</div>
            )}
          </div>
        </div>

        {heading.kind === "preparing" ? null : heading.kind === "outward" ? (
          <OutwardActionBody approval={heading.approval} />
        ) : preview ? (
          <div className="mx-3 mt-2 rounded-md border border-border bg-background px-3 py-2">
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs leading-snug text-secondary-foreground">
              {preview}
            </pre>
          </div>
        ) : null}

        <div className="px-3 py-2.5">
          <PermissionOptionList options={options} onSelect={onSelect} />
        </div>

        <div className="border-t border-border px-3 py-2.5">
          <Textarea
            ref={draftRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmitDraft();
              }
            }}
            rows={1}
            placeholder="Tell the agent what to do instead…"
            // One line until the user types more: the package field opens at
            // four lines, which would double the card for a fallback.
            className="min-h-0 resize-none"
          />
        </div>
      </div>
    </div>
  );
}

/** The numbered option list — shared with the plan review. Every option the
 *  wire sent, in wire order, each with its digit. */
export function PermissionOptionList({
  options,
  onSelect,
}: {
  options: PermissionOptionItem[];
  onSelect: (optionId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {options.map((opt, i) => (
        <PermissionOption
          key={opt.optionId}
          index={i + 1}
          option={opt}
          onSelect={() => onSelect(opt.optionId)}
        />
      ))}
    </div>
  );
}

const TONE_GLYPH = { allow: CheckCircle2, reject: XCircle, other: AlertTriangle } as const;

function PermissionOption({
  index,
  option,
  onSelect,
}: {
  index: number;
  option: PermissionOptionItem;
  onSelect: () => void;
}) {
  const { isPrimary } = option;
  return (
    <Button
      // The filled button is the one Enter picks; a reject wears the error
      // outline; everything else is a plain outline.
      variant={isPrimary ? "default" : option.tone === "reject" ? "destructive-outline" : "outline"}
      size="lg"
      onClick={onSelect}
      // A row, not a chip: full width, left-aligned, and a label that wraps
      // rather than running off the card.
      className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
    >
      <Kbd variant={isPrimary ? "inverse" : "default"}>{index}</Kbd>
      <Icon icon={TONE_GLYPH[option.tone]} size="md" />
      <span className="min-w-0 flex-1 py-2 break-words">{option.label}</span>
      {isPrimary && <Kbd variant="inverse">↵</Kbd>}
    </Button>
  );
}

/**
 * An outward action's headline (ADR-0014): the act and whom it reaches, then
 * the recipient in full — in place of "The agent wants to run …?", which
 * reads wrongly for a message.
 */
export function OutwardActionHeading({ approval }: { approval: OutwardApproval }) {
  return (
    <>
      <div className="text-base font-medium leading-snug text-foreground">{approval.title}</div>
      <div className="mt-0.5 text-xs text-secondary-foreground">{approval.recipient}</div>
    </>
  );
}

/**
 * An outward action's card while the host is still describing it (ADR-0014):
 * a loading heading and what is being looked up. The only option below is
 * Decline; the described card replaces this one when it is ready.
 */
export function OutwardPreparingHeading({ preparing }: { preparing: OutwardPreparing }) {
  return (
    <div role="status" aria-live="polite" data-testid="outward-preparing">
      <div className="flex items-center gap-2 text-base font-medium leading-snug text-foreground">
        <Spinner size="lg" label="" />
        <span>{preparing.title}</span>
      </div>
      <div className="mt-0.5 text-xs text-secondary-foreground">{preparing.note}</div>
    </div>
  );
}

/**
 * The exact words an outward action will post, in the tool-call preview's
 * box: the whole body, never truncated, scrolling inside the card when long.
 */
export function OutwardActionBody({ approval }: { approval: OutwardApproval }) {
  return (
    <div className="mx-3 mt-2 rounded-md border border-border bg-background px-3 py-2">
      <div
        data-testid="outward-body"
        className="max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-snug text-foreground"
      >
        {approval.body}
      </div>
    </div>
  );
}
