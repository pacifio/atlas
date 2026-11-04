// What Enter (or the send button) does: `planSubmit` decides from the text
// and the composer's gates, and this carries the plan out.

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { catalogEntry as agentCatalogEntry } from "@/features/agents/lib/agent-meta";
import type { ImageAttachment } from "@/types/agents";
import type { ChatInputHandle } from "../components/chat-input";
import { planSubmit } from "../lib/composer-submit";
import { forkSessionToNewTab } from "../lib/fork-session";
import type { StagedImage } from "../lib/image-attachment";
import { forgetSentTexts } from "../lib/mention-registry";
import type { MentionData } from "../lib/mentions";
import { enqueuePrompt } from "../lib/turn-queue";

export function useComposerSubmit({
  tabId,
  agentType,
  inputRef,
  valueRef,
  writeComposer,
  stagedImages,
  setStagedImages,
  disabled,
  githubSyncing,
  running,
  remoteDriving,
  modeUnrestored,
  heldForTerminal,
  onSend,
  onStop,
}: {
  tabId: string;
  agentType: string;
  inputRef: RefObject<ChatInputHandle | null>;
  valueRef: RefObject<string>;
  writeComposer: (text: string) => void;
  stagedImages: StagedImage[];
  setStagedImages: Dispatch<SetStateAction<StagedImage[]>>;
  disabled: boolean;
  githubSyncing: string | null;
  running: boolean;
  remoteDriving: boolean;
  modeUnrestored: boolean;
  heldForTerminal: boolean;
  onSend: (message: string, mentions: MentionData[], attachments?: ImageAttachment[]) => void;
  onStop?: () => void;
}) {
  return useCallback(() => {
    // The gates and their order are `planSubmit`'s (`composer-submit.ts`).
    const plan = planSubmit({
      text: inputRef.current?.getValue() ?? valueRef.current,
      disabled,
      githubSyncing: githubSyncing !== null,
      running,
      remoteDriving,
      modeUnrestored,
      heldForTerminal,
      supportsFork: agentCatalogEntry(agentType)?.supportsFork === true,
    });
    switch (plan.kind) {
      case "blocked":
      case "noop":
        return;
      case "stop":
        onStop?.();
        return;
      case "fork":
        forkSessionToNewTab(tabId);
        break;
      case "queue-command":
        if (plan.message) {
          const mentions = inputRef.current?.getMentions() ?? [];
          enqueuePrompt(tabId, plan.message, mentions);
          forgetSentTexts(mentions);
        }
        break;
      case "enqueue": {
        const mentions = inputRef.current?.getMentions() ?? [];
        enqueuePrompt(tabId, plan.text, mentions);
        forgetSentTexts(mentions);
        break;
      }
      case "send": {
        const mentions = inputRef.current?.getMentions() ?? [];
        // The wire shape is mime + bytes; the path stays with the composer.
        const images = stagedImages.map(({ path: _path, ...img }) => img);
        onSend(plan.text, mentions, images.length ? images : undefined);
        forgetSentTexts(mentions);
        if (images.length) setStagedImages([]);
        break;
      }
    }
    // Through `setValue`, not `clear`, so the send is one undo step away.
    writeComposer("");
    // The debounced draft mirror will collapse the empty value into a
    // `delete s.drafts[tabId]`, so no explicit clearDraft call is needed.
  }, [
    writeComposer,
    valueRef,
    running,
    onSend,
    onStop,
    tabId,
    agentType,
    disabled,
    stagedImages,
    githubSyncing,
    modeUnrestored,
    heldForTerminal,
    remoteDriving,
  ]);
}
