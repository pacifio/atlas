// The composer's window-event surface: focus requests, and every outside
// write into the draft (reply, prefill, insert, comment / review links, the
// handoff chip).

import { useEffect, type RefObject } from "react";
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { insertedDraft, type ChatInsertDetail } from "../lib/response-selection";
import { COMMENT_LINK_EVENT, type CommentLinkDetail } from "../lib/comment-mentions";
import { REVIEW_UNLINK_EVENT, type ReviewUnlinkDetail } from "../lib/review-comments";
import { SESSION_HANDOFF_EVENT, type SessionHandoffDetail } from "../lib/switch-agent";
import type { ChatInputHandle } from "../components/chat-input";

export function useComposerEvents({
  tabId,
  LazyChatInput,
  inputRef,
  valueRef,
  writeComposer,
  disabled,
  flushDraft,
}: {
  tabId: string;
  /** The editor component once its chunk has landed (`null` before). */
  LazyChatInput: unknown;
  inputRef: RefObject<ChatInputHandle | null>;
  valueRef: RefObject<string>;
  writeComposer: (text: string) => void;
  disabled: boolean;
  flushDraft: () => void;
}): void {
  // Auto-focus the composer whenever this panel mounts (tab switch back into
  // chat). If the editor chunk hasn't resolved yet, the next re-render
  // (driven by `LazyChatInput` flipping non-null) re-runs this effect and
  // focuses the real input as soon as it exists.
  useEffect(() => {
    if (!LazyChatInput) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [tabId, LazyChatInput]);

  // Listen for "Reply" clicks on message items — prepend a quote block.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ content: string }>).detail;
      if (!detail?.content) return;
      const quoted = detail.content
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      const cur = inputRef.current?.getValue() ?? valueRef.current;
      writeComposer(`${quoted}\n\n${cur}`);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-reply", handler);
    return () => window.removeEventListener("atlas:chat-reply", handler);
  }, [writeComposer, valueRef]);

  // Prefill the composer with raw text (empty-state prompt chips, a user row's
  // "Edit as new message"). Unlike "reply" this replaces the value verbatim (no
  // quote block) and focuses. Tab-scoped like `atlas:chat-send`: a tabId-less
  // event still reaches every mounted composer.
  //
  // Replacing is destructive, so a non-empty draft that differs from the new
  // text is offered back through an Undo toast rather than silently dropped.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; tabId?: string }>).detail;
      if (!detail?.text) return;
      if (detail.tabId != null && detail.tabId !== tabId) return;
      const previous = inputRef.current?.getValue() ?? valueRef.current;
      writeComposer(detail.text);
      requestAnimationFrame(() => inputRef.current?.focus());
      if (previous.trim() && previous !== detail.text) {
        toast("Replaced your draft", {
          action: {
            label: "Undo",
            onClick: () => {
              writeComposer(previous);
              requestAnimationFrame(() => inputRef.current?.focus());
            },
          },
        });
      }
    };
    window.addEventListener("atlas:chat-prefill", handler);
    return () => window.removeEventListener("atlas:chat-prefill", handler);
  }, [tabId, writeComposer, valueRef]);

  // Focus the composer on demand. The sidebar "+ new chat" button fires this
  // when it reuses an already-empty tab: no remount happens in that case, so
  // the mount auto-focus above doesn't re-run. Tab-scoped so only the active
  // composer grabs focus (the event fans out to every mounted chat tab).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId?: string }>).detail;
      if (detail?.tabId && detail.tabId !== tabId) return;
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-focus", handler);
    return () => window.removeEventListener("atlas:chat-focus", handler);
  }, [tabId]);

  // Append text to the composer (e.g. the KB bubble menu's "Send selection to
  // chat"). Unlike "prefill" this is NON-destructive (keeps any draft) and only
  // the ACTIVE session reacts, so it doesn't fan out to every mounted chat tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ChatInsertDetail>).detail;
      if (!detail?.text) return;
      if (detail.tabId ? detail.tabId !== tabId : useChatStore.getState().activeSessionId !== tabId)
        return;
      const cur = inputRef.current?.getValue() ?? valueRef.current;
      writeComposer(insertedDraft(cur, detail));
      // Heard: a cancelable sender (`askAgent`) writes the stored draft
      // itself when no composer took it.
      e.preventDefault();
      // An append lands beside work the user stayed on: the composer does
      // not take the focus from it.
      if (!detail.append) requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("atlas:chat-insert", handler);
    return () => window.removeEventListener("atlas:chat-insert", handler);
  }, [tabId, writeComposer, valueRef]);

  // A comment popover's link button (this tab's own recorded session's
  // comment) or a reply passage's Cite, as a chip at the caret. Linking one
  // already in the draft just focuses — the agent needs to be pointed at it
  // once.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CommentLinkDetail>).detail;
      if (!detail || detail.tabId !== tabId || disabled) return;
      const input = inputRef.current;
      if (!input) return;
      const linked = input
        .getMentions()
        .some((m) => m.kind === detail.mention.kind && m.id === detail.mention.id);
      if (!linked) input.insertMention(detail.mention, { padBefore: true });
      // Handled: the cite popover closes only on this (`linkCiteToComposer`).
      e.preventDefault();
      // Now, not after the debounce: the diff draws a review comment back
      // from the draft (`useComposerReviewComments`).
      if (detail.mention.kind === "review_comment") flushDraft();
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(COMMENT_LINK_EVENT, handler);
    return () => window.removeEventListener(COMMENT_LINK_EVENT, handler);
  }, [tabId, disabled, flushDraft]);

  // A review comment deleted where it was written (its annotation in the
  // diff or the file view): its chip leaves the prompt too.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ReviewUnlinkDetail>).detail;
      if (!detail || detail.tabId !== tabId) return;
      const input = inputRef.current;
      if (!input) return;
      input.removeMention("review_comment", detail.id);
      e.preventDefault();
      flushDraft();
    };
    window.addEventListener(REVIEW_UNLINK_EVENT, handler);
    return () => window.removeEventListener(REVIEW_UNLINK_EVENT, handler);
  }, [tabId, flushDraft]);

  // An agent switch with `agentSwitchBehavior: "handoff"`: the conversation
  // the tab just left, as a past-session chip at the start of the draft, so
  // the next message carries it to the new agent (`switch-agent.ts`).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SessionHandoffDetail>).detail;
      if (!detail || detail.tabId !== tabId) return;
      const input = inputRef.current;
      if (!input) return;
      const attached = input
        .getMentions()
        .some((m) => m.kind === "past_session" && m.id === detail.mention.id);
      if (!attached) input.insertMention(detail.mention, { atStart: true });
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(SESSION_HANDOFF_EVENT, handler);
    return () => window.removeEventListener(SESSION_HANDOFF_EVENT, handler);
  }, [tabId]);
}
