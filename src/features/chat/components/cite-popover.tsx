// What Cite opens: the passage, an optional note, and — on a session shared
// with the team — a switch that also posts it as a comment.
//
// A cite is private to the agent: submitting drops a `cited_text` chip into
// this session's composer (`cited-text.ts`), and nothing leaves the machine
// until the user sends. "Share with team" is the opt-in, and it goes through
// the ordinary comment path with the ordinary passage-comment body
// (`selectionCommentBody`), anchored to the reply's captured row, exactly as
// the Comment button would post it.
//
// Mounted only while the popover is open (`response-selection-actions.tsx`),
// so a selection that is never cited costs nothing here.

import { useCallback, useState } from "react";

import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import type { CommentActions } from "@/features/artifacts/components/comment-thread";
import { COMMENT_BODY_MAX, type AnchorKind } from "@/features/artifacts/lib/comments-api";
import { selectionCommentBody } from "@/features/artifacts/lib/selection-comment";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import { CITE_MAX_CHARS, capCitation, citedTextMention } from "../lib/cited-text";
import { linkCiteToComposer } from "../lib/comment-mentions";
import type { AnchorHit } from "../lib/comment-anchors";

/** Where a shared cite's comment goes. */
export interface CiteShareTarget {
  anchorKind: AnchorKind;
  rowId: string;
  post: CommentActions["post"];
}

/**
 * The comment gate, as the Comment button applies it: the reply is a captured
 * row (`useAnchorHit`) on a session whose comments are live (actions and a
 * directory, which `ChatCommentsController` supplies only for a synced
 * Organisation × cloud-bound Project × captured session — `chat_comment_target`).
 * Null means the switch is not drawn.
 */
export function citeShareTarget(
  hit: AnchorHit | null | undefined,
  actions: CommentActions | null,
  directory: OrgDirectory | null,
): CiteShareTarget | null {
  if (!hit || !actions || !directory) return null;
  return { anchorKind: hit.anchorKind, rowId: hit.rowId, post: actions.post };
}

export function CiteForm({
  text,
  messageId,
  rowId,
  tabId,
  share,
  onDone,
}: {
  /** The selection, as selected. */
  text: string;
  messageId: string;
  /** The reply's captured row, when the session is captured. */
  rowId: string | null;
  tabId: string;
  share: CiteShareTarget | null;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { truncated } = capCitation(text);
  const sharing = shared && share !== null;
  const trimmed = note.trim();
  // The comment is today's passage comment, byte for byte, so it carries the
  // whole selection and the server's cap applies to all of it.
  const commentLength = sharing ? selectionCommentBody(text, trimmed).length : 0;
  const over = commentLength > COMMENT_BODY_MAX;
  // A comment needs words of its own (the comment composer's rule).
  const needsNote = sharing && !trimmed;
  const ready = !busy && !over && !needsNote;

  const submit = useCallback(async () => {
    if (!ready) return;
    if (sharing) {
      setBusy(true);
      setError(null);
      try {
        await share.post(share.anchorKind, share.rowId, selectionCommentBody(text, trimmed), null);
      } catch (err) {
        // Nothing is cited either: the user asked for both, and the popover
        // stays open with their note so either can be retried.
        setError(err instanceof Error ? `Error: ${err.message}` : String(err));
        setBusy(false);
        return;
      }
    }
    if (!linkCiteToComposer(tabId, citedTextMention({ text, note: trimmed, messageId, rowId }))) {
      // No composer took it (disabled, or not mounted): stay open with the
      // note rather than close as if the cite had landed. A comment already
      // posted is not posted again — the switch goes off for the retry.
      setError(
        sharing
          ? "Shared with the team, but the composer could not take the cite. Try again once it is available."
          : "The composer could not take the cite. Try again once it is available.",
      );
      if (sharing) setShared(false);
      setBusy(false);
      return;
    }
    window.getSelection()?.removeAllRanges();
    onDone();
  }, [ready, sharing, share, text, trimmed, tabId, messageId, rowId, onDone]);

  return (
    <div className="flex flex-col gap-2">
      <blockquote
        aria-label="Cited passage"
        className="line-clamp-4 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs leading-snug text-muted-foreground"
      >
        {text}
      </blockquote>
      {truncated && <p className="caption">Long passage: the agent gets its start.</p>}
      <textarea
        value={note}
        rows={2}
        aria-label="Note for the agent"
        maxLength={CITE_MAX_CHARS}
        placeholder={sharing ? "Add a note for the agent and the team…" : "Add a note (optional)…"}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          // Enter cites, Shift+Enter breaks the line — the composers' rule.
          // Not while an IME is composing: that Enter commits the candidate.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        className="hide-scrollbar min-w-0 w-full resize-none overflow-x-hidden break-words rounded-lg border border-border bg-panel-input px-2 py-1.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-border-strong"
      />
      {share && (
        <div className="flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="text-xs text-foreground">Share with team</span>
            <span className="caption">Also posts it as a comment on this reply.</span>
          </span>
          <Switch
            size="sm"
            checked={shared}
            onCheckedChange={setShared}
            aria-label="Share with team"
          />
        </div>
      )}
      {needsNote && <p className="caption">A shared cite needs a note.</p>}
      {over && (
        <p className="text-3xs text-destructive">
          {commentLength.toLocaleString()} / {COMMENT_BODY_MAX.toLocaleString()} characters
          (including the selected passage)
        </p>
      )}
      {error && <p className="text-3xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button size="sm" disabled={!ready} onClick={() => void submit()}>
          {sharing ? "Cite and share" : "Cite"}
        </Button>
      </div>
    </div>
  );
}
