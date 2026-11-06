// The composer's text, as React sees it: the per-tab draft mirror, the
// empty↔non-empty edge, and the one path every programmatic rewrite takes.

import { useCallback, useState, type RefObject } from "react";
import { useComposerDraft } from "@/components/composer/use-composer-draft";
import type { ChatInputHandle } from "../components/chat-input";
import { collapseCites } from "../lib/cited-text";
import { mergeQueued } from "../lib/composer-submit";
import { rememberMention } from "../lib/mention-registry";
import { collapsePastes } from "../lib/pasted-text";
import { removeQueuedPrompt } from "../lib/turn-queue";
import { useChatStore } from "../stores/chat-store";

export function useComposerText({
  tabId,
  inputRef,
  projectPath,
}: {
  tabId: string;
  inputRef: RefObject<ChatInputHandle | null>;
  projectPath: string | null;
}) {
  // The editor owns the document; React only needs the empty↔non-empty EDGE
  // (for the submit button's tri-state), which the editor reports as an edge
  // (`onEmptyChange`) — a keystroke re-renders nothing here. The per-tab
  // draft mirror is `useComposerDraft`: a 300ms trailing debounce + a flush on
  // unmount (tab switches unmount this component, so nothing is lost; the
  // live-insert paths go through `atlas:chat-insert`, not the draft).
  const { setDraft } = useChatStore.use.actions();
  const draft = useComposerDraft(
    tabId,
    () => useChatStore.getState().drafts[tabId] ?? "",
    (text) => setDraft(tabId, text),
    () => inputRef.current?.getValue(),
  );
  const valueRef = draft.latest;
  const [hasText, setHasText] = useState(() => draft.initialValue.trim().length > 0);
  const onEmptyChange = useCallback((blank: boolean) => setHasText(!blank), []);
  // Every programmatic rewrite — reply, prefill, insert, queue recall — goes
  // through here. Before the editor chunk has landed there is no editor to
  // write to, so the text waits in the draft and seeds the editor on mount.
  const writeComposer = useCallback(
    (text: string) => {
      const input = inputRef.current;
      if (input) {
        input.setValue(text);
        return;
      }
      valueRef.current = text;
      setHasText(text.trim().length > 0);
      setDraft(tabId, text);
    },
    [tabId, setDraft, valueRef],
  );

  // A queued message's Edit: back into the composer, out of the queue.
  const editQueued = (q: string, i: number) => {
    const cur = inputRef.current?.getValue() ?? "";
    // A paste or a cite the queue inlined comes back as its
    // chip, not as every line it holds. Cites were written
    // last, so they come off first.
    const uncited = collapseCites(q);
    const { text, pastes } = collapsePastes(uncited.text);
    for (const p of pastes) rememberMention(p, projectPath);
    for (const c of uncited.cites) rememberMention(c, projectPath);
    writeComposer(mergeQueued(cur, text));
    removeQueuedPrompt(tabId, i);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return { draft, valueRef, hasText, onEmptyChange, writeComposer, editQueued };
}
