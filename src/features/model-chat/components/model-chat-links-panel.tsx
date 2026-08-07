import { useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Link2, ChevronRight, ExternalLink } from "lucide-react";
import type { ChatMessage } from "@/types/agent";
import { extractLinks, linkLabel } from "../lib/extract-links";

/**
 * Right-side overlay listing every link mentioned in the conversation — the
 * model-chat analogue of the agent chat's Bash / Plans panels. Clicking a row
 * opens the URL externally; the arrow jumps to the message it came from.
 */
export function ModelChatLinksPanel({
  messages,
  onClose,
  onJump,
}: {
  messages: ChatMessage[];
  onClose: () => void;
  onJump: (index: number) => void;
}) {
  const links = useMemo(() => extractLinks(messages), [messages]);

  return (
    <>
      <div
        className="absolute inset-0 z-20 bg-black/20 animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        style={{ width: 300 }}
        className="absolute right-0 top-0 bottom-0 z-30 flex flex-col border-l border-[var(--border-default)] bg-[var(--bg-sidebar)] shadow-[var(--shadow-overlay)] animate-slide-in-right"
      >
        <div className="flex items-center justify-between px-3 h-[32px] border-b border-[var(--border-default)] shrink-0">
          <div className="flex items-center gap-1.5">
            <Link2 size={11} className="text-[var(--text-tertiary)]" />
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">Links</span>
            <span className="text-[10px] text-[var(--text-tertiary)]">· {links.length}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
            title="Hide links"
          >
            <ChevronRight size={12} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
          {links.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-[var(--text-tertiary)]">
              No links yet
            </div>
          ) : (
            links.map((l, i) => (
              <div
                key={`${l.url}-${i}`}
                className="group flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <button
                  onClick={() => void openUrl(l.url)}
                  className="flex-1 min-w-0 text-left cursor-pointer"
                  title={l.url}
                >
                  <div className="truncate text-[11px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                    {linkLabel(l.url)}
                  </div>
                  <div className="truncate text-[9px] text-[var(--text-tertiary)]">
                    {l.role === "user" ? "you" : "assistant"}
                  </div>
                </button>
                <button
                  onClick={() => onJump(l.messageIndex)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-opacity"
                  title="Jump to message"
                >
                  <ExternalLink size={11} className="rotate-180" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
