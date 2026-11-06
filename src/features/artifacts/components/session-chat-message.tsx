/**
 * One turn in a Session chat: the container for `SessionChatMessageView`.
 *
 * It fills the view's three seams: prose through the markdown cache, diagrams
 * through `MermaidBlock` (which reaches the clipboard and the save dialog), and
 * a source chip's jump through `jumpTo`.
 */

import { MermaidBlock } from "@/components/mermaid-block";
import { CachedMarkdown } from "@/lib/markdown-cache";
import type { ChatMessage } from "@/types/agent";

import type { SourceRef } from "../lib/session-chat-api";
import { jumpTo } from "../lib/session-jump";
import { SessionChatMessageView } from "./views/session-chat-message-view";

// Kept here so existing importers (the detail's jump listener, the comments
// panel) are unchanged.
export { JUMP_EVENT, type JumpDetail } from "../lib/session-jump";

const renderMarkdown = (source: string) => (
  <CachedMarkdown source={source} className="atlas-prose-wrap" />
);
const renderDiagram = (code: string) => <MermaidBlock code={code} controls />;

export function SessionChatMessage({
  message,
  streaming,
  sources,
}: {
  message: ChatMessage;
  streaming: boolean;
  sources: SourceRef[] | undefined;
}) {
  return (
    <SessionChatMessageView
      message={message}
      streaming={streaming}
      sources={sources}
      renderMarkdown={renderMarkdown}
      renderDiagram={renderDiagram}
      onJump={jumpTo}
    />
  );
}
