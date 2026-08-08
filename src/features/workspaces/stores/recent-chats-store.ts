import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";
import type { AgentStatus, AgentType } from "@/types/agent";

/**
 * Recently-invoked agent chats across ALL projects — the sidebar "Chats"
 * section (Codex-style). A lightweight, persisted, capped list recorded from
 * the global `atlas:agents` listener whenever a chat session sees activity.
 * Clicking one jumps to that project and focuses the chat tab.
 */
export interface RecentChat {
  /** chat-store session key (the chat tab id). */
  tabId: string;
  projectPath: string;
  projectName: string;
  title: string;
  status: AgentStatus;
  /** Which agent drives this chat — for the brand icon in the row. */
  agentType?: AgentType;
  /** ACP session id — lets a closed chat be reopened/reloaded from disk. */
  acpSessionId?: string;
  /** Unix ms of last activity. */
  updatedAt: number;
}

const CAP = 15;

interface RecentChatsState {
  items: RecentChat[];
  actions: {
    /** Upsert a chat to the front of the list (by tabId). */
    record: (chat: RecentChat) => void;
    remove: (tabId: string) => void;
    /** Drop rows referring to a session deleted from disk. This list is
     *  persisted and never re-validated against storage, so the delete flow
     *  must purge it explicitly or the row lingers forever. */
    removeBySession: (acpSessionId: string) => void;
    clear: () => void;
  };
}

export const useRecentChatsStore = createSelectors(
  create<RecentChatsState>()(
    persist(
      (set) => ({
        items: [],
        actions: {
          record: (chat) =>
            set((s) => {
              const rest = s.items.filter((c) => c.tabId !== chat.tabId);
              return { items: [chat, ...rest].slice(0, CAP) };
            }),
          remove: (tabId) => set((s) => ({ items: s.items.filter((c) => c.tabId !== tabId) })),
          removeBySession: (acpSessionId) =>
            set((s) => ({
              items: s.items.filter(
                (c) => c.acpSessionId !== acpSessionId && c.tabId !== acpSessionId,
              ),
            })),
          clear: () => set({ items: [] }),
        },
      }),
      {
        name: "atlas-recent-chats",
        version: 1,
        partialize: (s) => ({ items: s.items }),
      },
    ),
  ),
);
