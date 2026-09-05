import { useMemo } from "react";
import { DraftEditor } from "./draft-editor";
import { useCommsStore } from "../stores/comms-store";

/**
 * The centre-panel host for a draft editor tab (`type: "comms-draft"`).
 *
 * A CENTER tab, not a chat-panel inline view: a document you co-write wants
 * editor real estate, splits, and a tab of its own — the chat panel is for
 * glancing. The tab carries only ids; the live objects are looked up so a
 * rename or a `sent` stamp reaches an already-open editor.
 */
export function CommsDraftTab({ convId, draftId }: { convId: string; draftId: string }) {
  const conversations = useCommsStore.use.conversations();
  const drafts = useCommsStore((s) => s.drafts[convId]);

  const conv = useMemo(
    () => conversations.find((c) => c.id === convId) ?? null,
    [conversations, convId],
  );
  const draft = useMemo(() => drafts?.find((d) => d.id === draftId) ?? null, [drafts, draftId]);

  if (!conv || !draft) {
    return (
      <div className="flex h-full items-center justify-center text-[11.5px] text-text-tertiary">
        This draft is no longer available.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--bg-surface)]">
      <DraftEditor conv={conv} draft={draft} />
    </div>
  );
}
