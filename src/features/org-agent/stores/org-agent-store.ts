// The Organisation agent's UI state: its conversations, and where each one is
// on screen. A conversation lives in ONE place at a time:
//
//   panel     the side panel, its home — the conversations open there are
//             tabs (`tabs`), one of them active (`activeId`)
//   floating  the messenger floating over the shell (`floatingId`) — where a
//             conversation goes when the panel's Minimise is pressed; its
//             Maximise brings it back to the panel
//   page      the full page (`pageId`) — where the panel's Full screen sends
//             it; the page's own button brings it back
//
// A conversation that is floating or on the page keeps its tab in the panel,
// and the panel says where it went instead of drawing it twice
// (`org-agent-side-panel.tsx`).
//
// Conversations are kept here until the server's history exists
// (`org-agent-api.ts`); then this store mirrors the server and holds only
// where things are. Persisted, so the panel's tabs and the conversations
// survive a restart.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";
import {
  reply,
  type OrgAgentConversation,
  type OrgAgentEffort,
  type OrgAgentMessage,
} from "../lib/org-agent-api";

/** A tab's title past this is cut. */
const TITLE_MAX = 60;

export const NEW_CHAT_TITLE = "New chat";

interface OrgAgentState {
  conversations: Record<string, OrgAgentConversation>;
  tabs: string[];
  activeId: string | null;
  floatingId: string | null;
  pageId: string | null;
  /** Conversations with an answer the person has not looked at. */
  unread: string[];
  /** Conversations waiting on the agent. Not persisted: a restart drops it. */
  pending: string[];
  /** Kept at the top of the history, in the order they were pinned. */
  pinned: string[];
  /** The composer's effort, for the next question. */
  effort: OrgAgentEffort;
  /** Deep research for the next question. */
  deepResearch: boolean;
  actions: {
    togglePin: (id: string) => void;
    setEffort: (effort: OrgAgentEffort) => void;
    setDeepResearch: (on: boolean) => void;
    /** A new conversation: a tab in the panel, active — or the full page's. */
    newChat: (opts?: { on?: "panel" | "page" }) => string;
    /** Show `id` in the panel (opening its tab if it has none). */
    activate: (id: string) => void;
    /** Close a panel tab. The conversation stays in history unless it never
     *  had a word, and leaves the messenger or the page with its tab. */
    closeTab: (id: string) => void;
    /** Panel → floating messenger. */
    minimise: (id: string) => void;
    /** Messenger or page → panel. */
    restoreToPanel: (id: string) => void;
    /** Panel or messenger → full page. The caller reveals the page. */
    fullScreen: (id: string) => void;
    /** The page's list: show `id` there. */
    openOnPage: (id: string | null) => void;
    /** Put the messenger away; the conversation goes back to its tab. */
    closeFloating: () => void;
    send: (id: string, text: string) => void;
    /** Ask again: drop the last answer and answer the last question anew. */
    retry: (id: string) => void;
    setFeedback: (id: string, messageId: string, feedback: "up" | "down" | null) => void;
    markRead: (id: string) => void;
    deleteConversation: (id: string) => void;
  };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The first prompt names the conversation, as on the web. */
function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line || NEW_CHAT_TITLE;
}

function withoutUnread(s: OrgAgentState, id: string): string[] {
  return s.unread.filter((u) => u !== id);
}

export const useOrgAgentStore = createSelectors(
  create<OrgAgentState>()(
    persist(
      (set, get) => {
        /** Answer `id`'s question `prompt`, into the store. */
        const answer = (id: string, prompt: string) => {
          const conversation = get().conversations[id];
          if (!conversation) return;
          set((s) => ({ pending: s.pending.includes(id) ? s.pending : [...s.pending, id] }));
          void reply(conversation, prompt)
            .catch(() => ({
              text: "The organisation agent could not be reached. Try again in a moment.",
            }))
            .then((got) => {
              const current = get().conversations[id];
              if (!current) {
                set((s) => ({ pending: s.pending.filter((p) => p !== id) }));
                return;
              }
              const message: OrgAgentMessage = {
                id: newId("oam"),
                role: "assistant",
                at: Date.now(),
                ...got,
              };
              set((s) => {
                // Unread unless it is somewhere on screen right now.
                const seen = s.activeId === id || s.floatingId === id || s.pageId === id;
                return {
                  conversations: {
                    ...s.conversations,
                    [id]: {
                      ...current,
                      messages: [...current.messages, message],
                      updatedAt: message.at,
                    },
                  },
                  pending: s.pending.filter((p) => p !== id),
                  unread: seen || s.unread.includes(id) ? s.unread : [...s.unread, id],
                };
              });
            });
        };

        return {
          conversations: {},
          tabs: [],
          activeId: null,
          floatingId: null,
          pageId: null,
          unread: [],
          pending: [],
          pinned: [],
          effort: "medium",
          deepResearch: false,
          actions: {
            togglePin: (id) =>
              set((s) => ({
                pinned: s.pinned.includes(id)
                  ? s.pinned.filter((p) => p !== id)
                  : [...s.pinned, id],
              })),
            setEffort: (effort) => set({ effort }),
            setDeepResearch: (deepResearch) => set({ deepResearch }),
            newChat: (opts) => {
              const id = newId("oac");
              const now = Date.now();
              const conversation: OrgAgentConversation = {
                id,
                title: NEW_CHAT_TITLE,
                messages: [],
                createdAt: now,
                updatedAt: now,
              };
              set((s) =>
                opts?.on === "page"
                  ? {
                      conversations: { ...withoutAbandoned(s, id), [id]: conversation },
                      pageId: id,
                    }
                  : {
                      conversations: { ...s.conversations, [id]: conversation },
                      tabs: [...s.tabs, id],
                      activeId: id,
                    },
              );
              return id;
            },
            activate: (id) =>
              set((s) => ({
                tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
                activeId: id,
                unread: withoutUnread(s, id),
              })),
            closeTab: (id) =>
              set((s) => {
                const conversation = s.conversations[id];
                // An empty chat closed is gone: it has nothing to keep.
                const empty = conversation && conversation.messages.length === 0;
                const conversations = { ...s.conversations };
                if (empty) delete conversations[id];
                const tabs = s.tabs.filter((t) => t !== id);
                const at = s.tabs.indexOf(id);
                return {
                  conversations,
                  tabs,
                  // The neighbour takes over, as a closed tab's does anywhere.
                  activeId:
                    s.activeId === id ? (tabs[Math.min(at, tabs.length - 1)] ?? null) : s.activeId,
                  floatingId: s.floatingId === id ? null : s.floatingId,
                  pageId: s.pageId === id ? null : s.pageId,
                };
              }),
            minimise: (id) =>
              set((s) => ({
                floatingId: id,
                pageId: s.pageId === id ? null : s.pageId,
                tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
                unread: withoutUnread(s, id),
              })),
            restoreToPanel: (id) =>
              set((s) => ({
                floatingId: s.floatingId === id ? null : s.floatingId,
                pageId: s.pageId === id ? null : s.pageId,
                tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
                activeId: id,
                unread: withoutUnread(s, id),
              })),
            fullScreen: (id) =>
              set((s) => ({
                pageId: id,
                floatingId: s.floatingId === id ? null : s.floatingId,
                tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
                unread: withoutUnread(s, id),
              })),
            openOnPage: (id) =>
              set((s) => ({
                conversations: withoutAbandoned(s, id),
                pageId: id,
                floatingId: id && s.floatingId === id ? null : s.floatingId,
                unread: id ? withoutUnread(s, id) : s.unread,
              })),
            closeFloating: () => set({ floatingId: null }),
            send: (id, text) => {
              const body = text.trim();
              const conversation = get().conversations[id];
              if (!body || !conversation || get().pending.includes(id)) return;
              const message: OrgAgentMessage = {
                id: newId("oam"),
                role: "user",
                text: body,
                at: Date.now(),
                ...(get().deepResearch && { deepResearch: true }),
              };
              set((s) => ({
                conversations: {
                  ...s.conversations,
                  [id]: {
                    ...conversation,
                    title:
                      conversation.messages.length === 0 ? titleFrom(body) : conversation.title,
                    messages: [...conversation.messages, message],
                    updatedAt: message.at,
                  },
                },
              }));
              answer(id, body);
            },
            retry: (id) => {
              const conversation = get().conversations[id];
              if (!conversation || get().pending.includes(id)) return;
              const messages = [...conversation.messages];
              if (messages[messages.length - 1]?.role === "assistant") messages.pop();
              const question = [...messages].reverse().find((m) => m.role === "user");
              if (!question) return;
              set((s) => ({
                conversations: { ...s.conversations, [id]: { ...conversation, messages } },
              }));
              answer(id, question.text);
            },
            setFeedback: (id, messageId, feedback) =>
              set((s) => {
                const conversation = s.conversations[id];
                if (!conversation) return s;
                return {
                  conversations: {
                    ...s.conversations,
                    [id]: {
                      ...conversation,
                      messages: conversation.messages.map((m) =>
                        m.id === messageId ? { ...m, feedback: feedback ?? undefined } : m,
                      ),
                    },
                  },
                };
              }),
            markRead: (id) => set((s) => ({ unread: withoutUnread(s, id) })),
            deleteConversation: (id) =>
              set((s) => {
                const conversations = { ...s.conversations };
                delete conversations[id];
                const tabs = s.tabs.filter((t) => t !== id);
                return {
                  conversations,
                  tabs,
                  activeId: s.activeId === id ? (tabs[tabs.length - 1] ?? null) : s.activeId,
                  floatingId: s.floatingId === id ? null : s.floatingId,
                  pageId: s.pageId === id ? null : s.pageId,
                  unread: withoutUnread(s, id),
                  pinned: s.pinned.filter((p) => p !== id),
                };
              }),
          },
        };
      },
      {
        name: "atlas-org-agent",
        version: 2,
        // Version 1 was the bottom bar's (its tabs, a window, `selectedId`):
        // the conversations carry over, where they were shown does not.
        migrate: (persisted) => {
          const p = (persisted ?? {}) as Partial<OrgAgentState>;
          return {
            conversations: p.conversations ?? {},
            unread: p.unread ?? [],
          } as Partial<OrgAgentState> as OrgAgentState;
        },
        partialize: (s) => ({
          conversations: s.conversations,
          tabs: s.tabs,
          activeId: s.activeId,
          floatingId: s.floatingId,
          pageId: s.pageId,
          unread: s.unread,
          pinned: s.pinned,
          effort: s.effort,
        }),
      },
    ),
  ),
);

/** The conversations, less the page's current one if the person is leaving
 *  it without having said a word and it is not open in the panel — the page
 *  opens on a fresh conversation, and those are not worth keeping. */
function withoutAbandoned(
  s: OrgAgentState,
  next: string | null,
): Record<string, OrgAgentConversation> {
  const conversations = { ...s.conversations };
  const previous = s.pageId ? s.conversations[s.pageId] : undefined;
  if (
    previous &&
    previous.id !== next &&
    previous.messages.length === 0 &&
    !s.tabs.includes(previous.id)
  ) {
    delete conversations[previous.id];
  }
  return conversations;
}

/** Today's questions, and today's deep-research ones — what the composer
 *  counts against the daily limits until the server reports them. */
export function usageToday(conversations: Record<string, OrgAgentConversation>): {
  asked: number;
  deep: number;
} {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let asked = 0;
  let deep = 0;
  for (const c of Object.values(conversations)) {
    for (const m of c.messages) {
      if (m.role !== "user" || m.at < start.getTime()) continue;
      asked += 1;
      if (m.deepResearch) deep += 1;
    }
  }
  return { asked, deep };
}

/** Every conversation, most recently active first — the history. */
export function conversationsByRecent(
  conversations: Record<string, OrgAgentConversation>,
): OrgAgentConversation[] {
  return Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt);
}
