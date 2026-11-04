// A comment's body with its mentions drawn, the quoted passage it was left
// on, and the field that writes one. Props only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Loader2 } from "lucide-react";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { cn } from "@/lib/utils";

import { avatarUser } from "../../lib/avatar-user";
import { splitSelectionComment } from "../../lib/selection-comment";
import { COMMENT_BODY_MAX } from "../../lib/session-detail-context";
import { AVATAR_PX } from "./comment-thread-styles";

/**
 * A comment body with its mentions drawn as pills.
 *
 * `<@user-id>` is the same syntax team chat uses and the same one the server
 * parses out of the stored body, so the three agree by construction. A split
 * rather than a markdown pass on purpose: a comment is a sentence, and running
 * the full pipeline over every one in a popover costs more than it renders.
 */
const MENTION = /<@([A-Za-z0-9_.:-]{1,128})>/g;

export function SelectionExcerpt({ text }: { text: string }) {
  return (
    <blockquote
      className="mb-2 max-h-24 overflow-auto whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs leading-snug text-muted-foreground"
      aria-label="Selected passage"
    >
      {text}
    </blockquote>
  );
}

export function CommentBody({ text, directory }: { text: string; directory: OrgDirectory }) {
  const excerpt = splitSelectionComment(text);
  return (
    <div className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-snug text-secondary-foreground">
      {excerpt && <SelectionExcerpt text={excerpt.selection} />}
      <Body text={excerpt?.body ?? text} directory={directory} />
    </div>
  );
}

function Body({ text, directory }: { text: string; directory: OrgDirectory }) {
  const parts = useMemo(() => {
    const out: Array<{ text: string; mention: boolean }> = [];
    let last = 0;
    for (const match of text.matchAll(MENTION)) {
      const at = match.index ?? 0;
      if (at > last) out.push({ text: text.slice(last, at), mention: false });
      out.push({ text: match[1], mention: true });
      last = at + match[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), mention: false });
    return out;
  }, [text]);

  return (
    <>
      {parts.map((part, i) =>
        part.mention ? (
          <span
            key={i}
            className="rounded bg-[var(--element-emphasis)] px-1 text-[var(--foreground)]"
          >
            @{directory.byId.get(part.text)?.name ?? part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function Composer({
  placeholder,
  onSend,
  directory,
  autoFocus,
  initial,
  onCancel,
  ariaLabel,
  bodyPrefixLength = 0,
}: {
  placeholder: string;
  /** The field's accessible name. The placeholder vanishes once there is
   *  text, which an edit always starts with. */
  ariaLabel?: string;
  onSend: (body: string) => Promise<void>;
  directory: OrgDirectory;
  autoFocus?: boolean;
  /** An existing body, for an edit. Its presence is what makes this one. */
  initial?: string;
  /** Escape. Only an edit has something to go back to. */
  onCancel?: () => void;
  bodyPrefixLength?: number;
}) {
  const editing = initial !== undefined;
  const [value, setValue] = useState(initial ?? "");
  const field = useRef<HTMLTextAreaElement | null>(null);
  // An edit opens with the caret after the text, where a correction starts —
  // not before the first word, where a bare focus leaves it.
  useEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.setSelectionRange(el.value.length, el.value.length);
    // Mount only: the caret belongs to the person once they start typing.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = directory.currentUserId ? directory.byId.get(directory.currentUserId) : null;

  const send = useCallback(() => {
    const body = value.trim();
    if (!body || busy || body.length + bodyPrefixLength > COMMENT_BODY_MAX) return;
    setBusy(true);
    setError(null);
    onSend(body)
      .then(() => setValue(""))
      // The text stays in the box on failure. There is no offline queue, so
      // clearing it would destroy what the developer wrote.
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [value, busy, onSend, bodyPrefixLength]);

  const totalLength = value.length + bodyPrefixLength;
  const over = totalLength > COMMENT_BODY_MAX;

  const ready = value.trim().length > 0 && !busy && !over;

  return (
    <div>
      {/* `items-center`, not `items-start`: at one row the field is 30px and the
       *  face is 18px, so top-aligning them left the avatar sitting visibly
       *  high. The field only grows on Shift+Enter, which is the rare case. */}
      <div className="flex items-center gap-1.5">
        {/* A placeholder rather than nothing when the roster has not resolved
         *  you: the field would otherwise jump left, and the rail measures
         *  against this element. */}
        {/* An edit sits under the comment's own byline, so a second face
         *  would only repeat it. */}
        {editing ? null : me ? (
          <span className="shrink-0">
            <AccountAvatar user={avatarUser(me)} size={AVATAR_PX} />
          </span>
        ) : (
          <span
            className="shrink-0 rounded-full bg-element-selected"
            style={{ width: AVATAR_PX, height: AVATAR_PX }}
          />
        )}
        {/* `relative`, so the send button can be pinned inside the field's
         *  right edge rather than stealing width from it. */}
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={field}
            value={value}
            autoFocus={autoFocus}
            aria-label={ariaLabel ?? placeholder.replace(/…$/, "")}
            placeholder={placeholder}
            rows={1}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // An input method is mid-composition: its Enter confirms a
              // candidate and its Escape abandons one. Neither is ours.
              // 229 covers WebKit, which reports the key before
              // `isComposing` flips.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape" && onCancel) {
                // Leave the edit without closing the popover around it.
                e.preventDefault();
                e.stopPropagation();
                onCancel();
                return;
              }
              // Enter sends, Shift+Enter breaks the line — the chat composer's
              // rule, because this reads as chat.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            // `hide-scrollbar` + `overflow-x-hidden`: the global 8px webkit
            // scrollbar otherwise renders as a strip under a one-row field on
            // any sub-pixel overflow. Vertical scrolling for Shift+Enter text
            // still works, just without a visible bar.
            className="hide-scrollbar min-w-0 w-full resize-none overflow-x-hidden break-words rounded-lg border border-border bg-panel-input py-1.5 pl-2 pr-8 text-xs text-[var(--foreground)] outline-none transition-colors placeholder:text-[var(--muted-foreground)] focus:border-border-strong"
          />
          {/* The agent composer's squircle send, at this surface's scale, and
           *  pinned so it does not ride down as the field grows. It carries the
           *  return glyph rather than an arrow because Enter is what actually
           *  sends here — the button is the discoverable form of the shortcut,
           *  not a second way to do it. */}
          <button
            type="button"
            aria-label={editing ? "Save comment" : "Send comment"}
            disabled={!ready}
            onClick={send}
            className={cn(
              "absolute right-[5px] top-[5px] flex size-5 items-center justify-center rounded-md border transition-colors",
              ready
                ? "cursor-pointer border-transparent text-[var(--foreground)] hover:border-[var(--border)] hover:bg-element-hover"
                : "cursor-not-allowed border-transparent text-disabled",
            )}
          >
            {busy ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <CornerDownLeft size={11} strokeWidth={2.25} />
            )}
          </button>
        </div>
      </div>
      {over && (
        <p className="mt-1 text-3xs text-error">
          {totalLength.toLocaleString()} / {COMMENT_BODY_MAX.toLocaleString()} characters
          {bodyPrefixLength > 0 ? " (including the selected passage)" : ""}
        </p>
      )}
      {error && <p className="mt-1 text-3xs text-error">{error}</p>}
    </div>
  );
}
