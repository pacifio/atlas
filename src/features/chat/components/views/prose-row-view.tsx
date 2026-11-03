import { memo, useRef } from "react";
import { cn } from "@/lib/utils";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { formatTime } from "@/lib/format-time";
import type { ProseRow } from "../../lib/turn-rows";
import { StreamingMarkdown } from "../streaming-markdown";
import { ProseRowActions } from "../prose-row-actions";
import { Column } from "./transcript-row-parts";

// ── Prose ──────────────────────────────────────────────────────────────────

export const ProseRowView = memo(function ProseRowView({
  row,
  tabId,
  agentLabel,
  priority,
  pinScopeKey,
  canBranch = false,
  fileRoot,
}: {
  row: ProseRow;
  tabId: string;
  agentLabel: string;
  /** Position in the thread — newest parses first. See `CachedMarkdown`. */
  priority: number;
  pinScopeKey: string;
  /** True only for the session's latest settled response on an agent that can
   *  fork, with no turn running. Resolved by the transcript, like `canRetry`. */
  canBranch?: boolean;
  /** The session's project root: paths in the reply become file chips. */
  fileRoot?: string;
}) {
  const proseRef = useRef<HTMLDivElement>(null);
  const messageId = row.id.slice(2);
  return (
    // A settled response reserves the gap its action bar sits in (see
    // `prose-row-actions.tsx`); the streaming tail does not — nothing here
    // works on a response that is still arriving, and the one reflow happens
    // when the turn ends, deliberately.
    // A response whose footer sits below its turn's changed-files card
    // (`footerBelow`) reserves nothing here; the footer row does.
    <Column className={cn("py-2", !row.streaming && !row.footerBelow && "relative pb-7")}>
      {/* One left-aligned group: model, dot, time. The timestamp used to be
          pushed to the far right with `ml-auto`, which left a long empty span
          across a 760px column and read as two unrelated headers rather than
          one line of provenance. It stays against the left edge the prose
          below it also starts from.

          What answers a message is the MODEL, so the model leads; the time is
          the qualifier and follows the separator. The agent glyph is gone —
          it repeated what the model name already says, and an icon is the
          heaviest possible way to say it in a line that competes with the
          prose underneath. `agentLabel` is the fallback for a row whose model
          is unknown (an older thread, a resumed session), so the line never
          degrades to a bare timestamp with no provenance at all. */}
      {row.showHeader && (
        <div className="flex h-[22px] items-center gap-1.5">
          <span className="min-w-0 truncate font-mono text-2xs text-[var(--muted-foreground)]">
            {row.model || agentLabel}
          </span>
          {/* A replayed response's time is when Atlas replayed it, not when
              it was said: no clock rather than a wrong one. */}
          {!row.timestampApproximate && (
            <>
              <span aria-hidden className="shrink-0 text-2xs text-[var(--atlas-text-disabled)]">
                ·
              </span>
              <span className="shrink-0 font-mono text-2xs text-[var(--muted-foreground)]">
                {formatTime(row.timestamp, { hour: "2-digit", minute: "2-digit" })}
              </span>
            </>
          )}
        </div>
      )}
      {/* Settled prose goes through the plain cached renderer: its root IS
          `.atlas-prose`, so the block metrics apply to real block elements and
          a scrolled-back message is a pure cache hit. The streaming tail uses
          the block-splitting renderer, where only the trailing block re-parses
          per frame. */}
      {row.streaming ? (
        <StreamingMarkdown
          source={row.text}
          streaming
          unstyled
          priority={priority}
          fileRoot={fileRoot}
          className="atlas-prose"
        />
      ) : (
        // `data-agent-response` makes the reply citable; `data-comment-anchor`
        // makes it commentable (`response-selection.ts`).
        <div ref={proseRef} data-agent-response={messageId} data-comment-anchor={messageId}>
          <CachedMarkdown
            source={row.text}
            unstyled
            priority={priority}
            fileRoot={fileRoot}
            className="atlas-prose"
          />
        </div>
      )}
      {!row.streaming && !row.footerBelow && (
        <ProseRowActions
          tabId={tabId}
          messageId={messageId}
          timestamp={row.timestamp}
          text={row.text}
          pinScopeKey={pinScopeKey}
          canBranch={canBranch}
          showTimestamp={!row.showHeader && !row.timestampApproximate}
        />
      )}
    </Column>
  );
});
