// Team-chat (comms) UI state.
//
// A **projection**, not a source of truth. Rust owns the chat state — it holds
// the socket, the `seq` watermark and the pending sends — and this store only
// applies the events it emits and invokes commands back. It decides nothing,
// exactly as `auth-store` decides nothing about auth.
//
// Two consequences worth stating, because both look like omissions:
//   - `send` does not build an optimistic row. Rust does, and emits it, because
//     the `ack` carries only ids and the body has to be remembered in one place.
//   - nothing here increments an unread badge. Counts are server-held and
//     arrive via `readsChanged`; a local count always drifts.
//
// What IS owned here is panel chrome: which tabs are open, which is active, and
// what is half-typed in each composer. None of that is chat state.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { comms, type CommsEnvelope, type ConnectionInfo } from "../lib/comms-api";
import type { PendingAttachment } from "../components/comms-composer";
import { CHAT_MESSAGE_ATTACHMENT_MAX, TYPING_EXPIRY_MS } from "../types";
import type {
  ChatCall,
  ChatConversation,
  ChatReaction,
  ChatReadState,
  CommsMessage,
  OrgMemberProfile,
} from "../types";

/**
 * One tab in the panel header — a browser-style VIEW, not a pinned
 * conversation. `convId: null` is the home view (channels + contacts); opening
 * a conversation navigates the tab in place, and `+` makes a fresh view. This
 * is what lets someone keep a channel and a DM side by side without every
 * click growing the strip.
 */
export interface CommsTab {
  id: string;
  convId: string | null;
}

/** What the composer is currently doing, per conversation. */
export interface ComposerState {
  draft: string;
  replyTo: string | null;
  editing: string | null;
  /** Files staged for this message. Server-side they are staged until a send
   *  claims them, so abandoning a draft leaks nothing. */
  attachments: PendingAttachment[];
}

const emptyComposer = (): ComposerState => ({
  draft: "",
  replyTo: null,
  editing: null,
  attachments: [],
});

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `x-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

const DISCONNECTED: ConnectionInfo = {
  state: "disconnected",
  reason: null,
  epoch: 0,
  orgId: null,
};

interface CommsState {
  panelOpen: boolean;

  connection: ConnectionInfo;

  me: string;
  /** Resolved from the org roster, not from chat — the server sends ids only. */
  members: OrgMemberProfile[];
  online: string[];

  conversations: ChatConversation[];
  /** `hello.discoverable` — kept separate from joined, deliberately. */
  discoverable: ChatConversation[];
  reads: ChatReadState[];

  messages: Record<string, CommsMessage[]>;
  /** Conversations whose first page is in flight — drives the transcript
   *  spinner. Keyed by conv id; absent = not loading. */
  loading: Record<string, boolean>;
  /** Conversations whose first page HAS landed. Separates "loaded and empty"
   *  from "never loaded" — the transcript intro used to claim the former
   *  whenever the fetch had quietly failed. */
  hydrated: Record<string, boolean>;
  /** Conversations whose load exhausted its retries, with the last error.
   *  Only set once retrying has genuinely given up. */
  loadError: Record<string, string>;
  /** Reaction rows INDEXED BY MESSAGE. The `reactionsChanged` event carries one
   *  message's rows, so applying it replaces exactly one key — every other
   *  message's slice keeps identity and its row's memo holds. A flat array here
   *  meant one reaction anywhere repainted every row everywhere. */
  reactionsByMessage: Record<string, ChatReaction[]>;
  pinned: string[];
  /** conv -> user -> when they last said so; aged out on a timer. */
  typing: Record<string, Record<string, number>>;
  /** In-flight downloads by the object's own id (attachment id / track id).
   *  A key exists only while the arc should render; complete/failed delete it. */
  downloads: Record<string, { got: number; total: number }>;
  /** Calls by id, assembled from journaled frames. Ended calls are kept — the
   *  card becoming "over" is the point; removing it would read as a call that
   *  never happened. */
  calls: Record<string, ChatCall>;

  tabs: CommsTab[];
  activeTabId: string | null;
  composers: Record<string, ComposerState>;

  actions: {
    open: () => void;
    close: () => void;
    toggle: () => void;

    /** Hydrate from Rust. Safe to call repeatedly; a resync calls it. */
    hydrate: () => Promise<void>;
    /** Apply one bridge envelope. The only writer for server-owned state. */
    applyEnvelope: (envelope: CommsEnvelope) => void;
    setMembers: (members: OrgMemberProfile[]) => void;
    /** Drop everything server-owned, for an org switch. */
    reset: () => void;

    /** Navigate the ACTIVE tab to a conversation (creates a tab if none). */
    openConversation: (convId: string) => void;
    /** Navigate the active tab back to the home view. */
    goHome: () => void;
    /** A fresh view, starting at home. */
    newTab: () => void;
    /** Adopt a conversation the server just created for us (a fresh DM),
     *  so navigation does not have to wait for the broadcast round-trip. */
    adoptConversation: (conv: ChatConversation) => void;
    closeTab: (tabId: string) => void;
    setActiveTab: (tabId: string) => void;
    moveTab: (tabId: string, toIndex: number) => void;

    setDraft: (convId: string, draft: string) => void;
    setReplyTo: (convId: string, messageId: string | null) => void;
    beginEdit: (convId: string, messageId: string) => void;
    cancelComposerIntent: (convId: string) => void;

    send: (convId: string) => void;
    commitEdit: (convId: string) => void;
    deleteMessage: (convId: string, messageId: string) => void;
    react: (messageId: string, emoji: string, on: boolean) => void;
    togglePin: (messageId: string, on: boolean) => void;
    markRead: (convId: string) => void;
    joinChannel: (convId: string) => void;
    /** Begin uploading dropped/picked files for a conversation. */
    attachFiles: (convId: string, paths: string[]) => void;
    removeAttachment: (convId: string, uploadId: string) => void;
    loadOlder: (convId: string) => Promise<void>;
    /** Re-attempt a conversation's first page after retries were exhausted. */
    retryConversation: (convId: string) => void;
  };
}

const serverOwned = () => ({
  connection: DISCONNECTED,
  me: "",
  online: [] as string[],
  conversations: [] as ChatConversation[],
  discoverable: [] as ChatConversation[],
  reads: [] as ChatReadState[],
  messages: {} as Record<string, CommsMessage[]>,
  loading: {} as Record<string, boolean>,
  hydrated: {} as Record<string, boolean>,
  loadError: {} as Record<string, string>,
  reactionsByMessage: {} as Record<string, ChatReaction[]>,
  pinned: [] as string[],
  typing: {} as Record<string, Record<string, number>>,
  calls: {} as Record<string, ChatCall>,
  downloads: {} as Record<string, { got: number; total: number }>,
});

export const useCommsStore = createSelectors(
  create<CommsState>((set, get) => ({
    panelOpen: false,
    ...serverOwned(),
    members: [],

    tabs: [{ id: "tab_home", convId: null }],
    activeTabId: "tab_home",
    composers: {},

    actions: {
      open: () => set({ panelOpen: true }),
      close: () => set({ panelOpen: false }),
      toggle: () => set((s) => ({ panelOpen: !s.panelOpen })),

      setMembers: (members) => set({ members }),

      reset: () =>
        set({
          ...serverOwned(),
          // Org-scoped, but deliberately NOT in serverOwned(): a same-org
          // resync must not blank names while the roster refetches. A reset
          // or retarget crosses orgs, so here it goes.
          members: [],
          tabs: [{ id: "tab_home", convId: null }],
          activeTabId: "tab_home",
          composers: {},
        }),

      hydrate: async () => {
        try {
          const snapshot = await comms.snapshot();
          set({
            connection: snapshot.connection,
            me: snapshot.me ?? "",
            conversations: snapshot.conversations,
            calls: Object.fromEntries((snapshot.calls ?? []).map((c) => [c.id, c])),
            discoverable: snapshot.discoverable,
            reads: snapshot.reads,
            online: snapshot.online,
          });
          // Re-read every open tab: a resync means the transcripts we hold may
          // have gaps we cannot see from here.
          const tabs = get().tabs;
          for (const tab of tabs) {
            if (!tab.convId) continue;
            // A conversation we have never fetched needs the REST page, not a
            // state snapshot: `conversationSnapshot` reads what Rust already
            // holds, which for an unhydrated conversation is nothing.
            if (!get().hydrated[tab.convId]) {
              loadConversation(tab.convId, set);
              continue;
            }
            try {
              const win = await comms.conversationSnapshot(tab.convId);
              set((s) => ({
                messages: {
                  ...s.messages,
                  [tab.convId as string]: mergeWindow(
                    s.messages[tab.convId as string],
                    win.messages ?? [],
                  ),
                },
                reactionsByMessage: mergeReactions(s.reactionsByMessage, win.reactions),
                pinned: mergePins(s.pinned, win.pinned_message_ids),
              }));
            } catch {
              // A conversation we can no longer read is not an error worth
              // shouting about — the conversation list will have dropped it.
            }
          }
        } catch {
          // Chat is not ready (no org, signed out). The gate handles the copy.
        }
      },

      applyEnvelope: (envelope) => {
        const state = get();
        // An org mismatch is not a stale envelope to drop — Rust is the
        // authority on where the socket points, and a mismatch means the
        // target MOVED under us (boot reconciliation correcting a clobbered
        // active org, or a switch settling). Every slice we hold belongs to
        // the old org, so adopt the new one wholesale: reset and re-hydrate.
        // (Genuinely stale events cannot reach here: retargeting bumps the
        // generation in Rust, which silences the old supervisor first.)
        const currentOrg = state.connection.orgId;
        if (envelope.org && currentOrg && envelope.org !== currentOrg) {
          set({
            ...serverOwned(),
            // The old org's roster must not survive the retarget — the panel
            // keys its refetch off `connection.orgId`, set just below.
            members: [],
            connection: {
              state: "connecting",
              reason: null,
              epoch: envelope.epoch,
              orgId: envelope.org,
            },
          });
          void get().actions.hydrate();
          return;
        }

        const ev = envelope.ev;
        switch (ev.kind) {
          case "connection": {
            const wasOpen = state.connection.state === "open";
            set((s) => ({
              connection: {
                ...s.connection,
                state: ev.state,
                reason: ev.reason,
                epoch: envelope.epoch,
                orgId: envelope.org || s.connection.orgId,
              },
            }));
            // The socket opening is proof the org target and credential now
            // exist — which is exactly what a too-early first-page fetch was
            // missing. Anything still unloaded gets another go, immediately.
            if (!wasOpen && ev.state === "open") retryUnloadedConversations();
            return;
          }

          case "resync":
            void get().actions.hydrate();
            return;

          case "messageAppended":
            set((s) => {
              const list = s.messages[ev.conv_id] ?? [];
              if (list.some((m) => m.id === ev.message.id)) return {};
              return {
                messages: { ...s.messages, [ev.conv_id]: sortBySeq([...list, ev.message]) },
                // They finished the sentence — a better signal than a timeout,
                // because it is exactly when the hint stopped being true.
                typing: withoutTyper(s.typing, ev.conv_id, ev.message.author_id),
              };
            });
            return;

          case "messageUpdated":
            set((s) => {
              const list = s.messages[ev.conv_id] ?? [];
              // `replaced_id` is the optimistic row an ack promoted.
              const dropId = ev.replaced_id ?? ev.message.id;
              const next = list.filter((m) => m.id !== dropId && m.id !== ev.message.id);
              return {
                messages: { ...s.messages, [ev.conv_id]: sortBySeq([...next, ev.message]) },
              };
            });
            return;

          case "conversationsChanged":
            set({ conversations: ev.conversations, discoverable: ev.discoverable });
            return;

          case "readsChanged":
            // Server-held, wholesale. Nothing here computes a badge.
            set((s) => ({ reads: mergeReads(s.reads, ev.reads) }));
            return;

          case "readChanged":
            // The single-row fast path: one read receipt used to re-ship the
            // whole table.
            set((s) => ({ reads: mergeReads(s.reads, [ev.read]) }));
            return;

          case "presence":
            // The whole set — an assignment, not a merge. But an UNCHANGED set
            // must not take a new identity: every socket reconnect and grace-
            // window event repaints the whole panel otherwise.
            set((s) =>
              s.online.length === ev.online.length && s.online.every((id, i) => id === ev.online[i])
                ? {}
                : { online: ev.online },
            );
            return;

          case "typing":
            set((s) =>
              s.typing[ev.conv_id]?.[ev.user_id] === ev.at_ms
                ? {}
                : {
                    typing: {
                      ...s.typing,
                      [ev.conv_id]: { ...s.typing[ev.conv_id], [ev.user_id]: ev.at_ms },
                    },
                  },
            );
            return;

          case "reactionsChanged":
            // Surgical: one key changes, every other slice keeps identity.
            set((s) => ({
              reactionsByMessage: { ...s.reactionsByMessage, [ev.message_id]: ev.rows },
            }));
            return;

          case "pinsChanged":
            set((s) => ({ pinned: mergePins(s.pinned, ev.pinned_message_ids) }));
            return;

          case "uploadProgress":
            set((s) => ({
              composers: Object.fromEntries(
                Object.entries(s.composers).map(([convId, c]) => [
                  convId,
                  {
                    ...c,
                    attachments: c.attachments.map((a) =>
                      a.uploadId === ev.upload_id
                        ? {
                            ...a,
                            sentBytes: ev.sent_bytes,
                            totalBytes: ev.total_bytes,
                            state: ev.state,
                            error: ev.error ?? undefined,
                          }
                        : a,
                    ),
                  },
                ]),
              ),
            }));
            return;

          case "downloadProgress": {
            if (ev.state === "downloading") {
              set((s) => ({
                downloads: {
                  ...s.downloads,
                  [ev.download_id]: { got: ev.got_bytes, total: ev.total_bytes },
                },
              }));
            } else {
              // complete or failed: the arc unmounts; failure surfaces as a
              // toast at the call site, which owns the user-facing wording.
              set((s) => {
                if (!(ev.download_id in s.downloads)) return s;
                const next = { ...s.downloads };
                delete next[ev.download_id];
                return { downloads: next };
              });
            }
            return;
          }

          case "callChanged":
            set((s) => ({ calls: { ...s.calls, [ev.call.id]: ev.call } }));
            return;

          case "memberChanged":
          case "error":
            return;
        }
      },

      openConversation: (convId) => {
        const s = get();
        const active = s.tabs.find((t) => t.id === s.activeTabId) ?? null;
        const leaving = active?.convId ?? null;
        let tabs: CommsTab[];
        let activeTabId: string | null;
        if (active) {
          tabs = s.tabs.map((t) => (t.id === active.id ? { ...t, convId } : t));
          activeTabId = active.id;
        } else {
          const tab = { id: `tab_${uid()}`, convId };
          tabs = [...s.tabs, tab];
          activeTabId = tab.id;
        }
        set(() => ({
          tabs,
          activeTabId,
          panelOpen: true,
        }));
        releaseIfUnshown(leaving, tabs);
        loadConversation(convId, set);
      },

      goHome: () => {
        const s = get();
        const active = s.tabs.find((t) => t.id === s.activeTabId);
        if (!active || active.convId === null) return;
        const leaving = active.convId;
        const tabs = s.tabs.map((t) => (t.id === active.id ? { ...t, convId: null } : t));
        set({ tabs });
        releaseIfUnshown(leaving, tabs);
      },

      newTab: () => {
        const tab = { id: `tab_${uid()}`, convId: null };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      },

      // An UPSERT, not an add: a PATCH response (rename, archive) goes
      // through here too, and replacing by id paints the caller's own change
      // without waiting for the `conversation.updated` broadcast round trip.
      adoptConversation: (conv) =>
        set((s) =>
          s.conversations.some((c) => c.id === conv.id)
            ? { conversations: s.conversations.map((c) => (c.id === conv.id ? conv : c)) }
            : { conversations: [...s.conversations, conv] },
        ),

      closeTab: (tabId) => {
        const s = get();
        const idx = s.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const closing = s.tabs[idx];
        let tabs = s.tabs.filter((t) => t.id !== tabId);
        let activeTabId = s.activeTabId;
        // The strip never empties: closing the last view leaves a fresh home.
        if (tabs.length === 0) {
          tabs = [{ id: `tab_${uid()}`, convId: null }];
          activeTabId = tabs[0].id;
        } else if (s.activeTabId === tabId) {
          activeTabId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? null;
        }
        set({ tabs, activeTabId });
        releaseIfUnshown(closing.convId, tabs);
      },

      setActiveTab: (tabId) => set({ activeTabId: tabId }),

      moveTab: (tabId, toIndex) =>
        set((s) => {
          const from = s.tabs.findIndex((t) => t.id === tabId);
          if (from === -1 || toIndex < 0 || toIndex >= s.tabs.length) return {};
          const tabs = [...s.tabs];
          const [moved] = tabs.splice(from, 1);
          tabs.splice(toIndex, 0, moved);
          return { tabs };
        }),

      setDraft: (convId, draft) => {
        set((s) => ({
          composers: {
            ...s.composers,
            [convId]: { ...(s.composers[convId] ?? emptyComposer()), draft },
          },
        }));
        // Rust throttles to one per three seconds; the server drops excess in
        // silence, so the throttle cannot live here where it could be skipped.
        if (draft.length > 0) void comms.typing(convId).catch(() => {});
      },

      setReplyTo: (convId, messageId) =>
        set((s) => ({
          composers: {
            ...s.composers,
            [convId]: {
              ...(s.composers[convId] ?? emptyComposer()),
              replyTo: messageId,
              editing: null,
            },
          },
        })),

      beginEdit: (convId, messageId) =>
        set((s) => {
          const body = (s.messages[convId] ?? []).find((m) => m.id === messageId)?.body ?? "";
          return {
            composers: {
              ...s.composers,
              // Attachments are preserved: editing rewrites the body only, and
              // dropping staged uploads here would silently abandon them.
              [convId]: {
                ...(s.composers[convId] ?? emptyComposer()),
                draft: body,
                replyTo: null,
                editing: messageId,
              },
            },
          };
        }),

      cancelComposerIntent: (convId) =>
        set((s) => ({
          composers: {
            ...s.composers,
            [convId]: { ...(s.composers[convId] ?? emptyComposer()), replyTo: null, editing: null },
          },
        })),

      // The optimistic row comes back as `messageAppended`; nothing is built
      // here, so there is one place a message can be described.
      send: (convId) => {
        const composer = get().composers[convId] ?? emptyComposer();
        const body = composer.draft.trim();
        const ready = composer.attachments
          .filter((a) => a.state === "complete" && a.fileId)
          .map((a) => a.fileId as string);
        // Empty body is legal with an attachment, and only then.
        if (!body && ready.length === 0) return;
        set((s) => ({ composers: { ...s.composers, [convId]: emptyComposer() } }));
        void comms.send(convId, body, composer.replyTo, ready).catch((e) => {
          console.warn("comms: send failed:", convId, e);
        });
      },

      attachFiles: (convId, paths) => {
        const existing = (get().composers[convId] ?? emptyComposer()).attachments;
        const room = CHAT_MESSAGE_ATTACHMENT_MAX - existing.length;
        if (room <= 0) return;
        for (const path of paths.slice(0, room)) {
          const uploadId = uid();
          const filename = path.split("/").pop() || path;
          set((s) => {
            const c = s.composers[convId] ?? emptyComposer();
            return {
              composers: {
                ...s.composers,
                [convId]: {
                  ...c,
                  attachments: [
                    ...c.attachments,
                    {
                      uploadId,
                      fileId: null,
                      filename,
                      totalBytes: 0,
                      sentBytes: 0,
                      state: "uploading" as const,
                    },
                  ],
                },
              },
            };
          });
          void comms
            .uploadAttachment(convId, uploadId, path)
            .then(({ fileId }) => patchAttachment(set, convId, uploadId, { fileId }))
            .catch((e) => {
              console.warn("comms: upload failed:", filename, e);
              patchAttachment(set, convId, uploadId, {
                state: "failed",
                error: String(e),
              });
            });
        }
      },

      removeAttachment: (convId, uploadId) => {
        void comms.cancelUpload(uploadId).catch(() => {});
        set((s) => {
          const c = s.composers[convId] ?? emptyComposer();
          return {
            composers: {
              ...s.composers,
              [convId]: {
                ...c,
                attachments: c.attachments.filter((a) => a.uploadId !== uploadId),
              },
            },
          };
        });
      },

      commitEdit: (convId) => {
        const composer = get().composers[convId] ?? emptyComposer();
        const target = composer.editing;
        const body = composer.draft.trim();
        if (!target || !body) return;
        set((s) => ({ composers: { ...s.composers, [convId]: emptyComposer() } }));
        void comms.edit(target, body).catch(() => {});
      },

      deleteMessage: (_convId, messageId) => {
        void comms.delete(messageId).catch(() => {});
      },

      react: (messageId, emoji, on) => {
        void comms.react(messageId, emoji, on).catch(() => {});
      },

      togglePin: (messageId, on) => {
        void comms.pin(messageId, on).catch(() => {});
      },

      markRead: (convId) => {
        const list = get().messages[convId] ?? [];
        const seq = list[list.length - 1]?.seq;
        if (seq === undefined) return;
        void comms.read(convId, seq).catch(() => {});
      },

      joinChannel: (convId) => {
        void comms.join(convId).catch(() => {});
      },

      retryConversation: (convId) => {
        convAttempts.delete(convId);
        loadConversation(convId, set);
      },

      loadOlder: async (convId) => {
        const list = get().messages[convId] ?? [];
        const oldest = list[0]?.seq;
        if (oldest === undefined) return;
        try {
          const page = await comms.loadOlder(convId, oldest);
          set((s) => {
            const current = s.messages[convId] ?? [];
            const seen = new Set(current.map((m) => m.id));
            const fresh = page.messages.filter((m) => !seen.has(m.id));
            return { messages: { ...s.messages, [convId]: sortBySeq([...fresh, ...current]) } };
          });
        } catch {
          // Nothing to do: the transcript simply does not extend further.
        }
      },
    },
  })),
);

/**
 * Adopt a window snapshot WITHOUT letting it erase what we hold.
 *
 * The bug this guards (same class as the resume-replay clobber): opening a
 * conversation races boot-time resyncs. `openConversation`'s REST-hydrated
 * window and `hydrate()`'s per-tab re-read both land via `set`, and the one
 * that read Rust EARLIER can apply LATER — an empty pre-hydration snapshot
 * then overwrites a full transcript, silently, with no error anywhere. The
 * rule: an empty incoming window never replaces content, and a non-empty one
 * is unioned by id (locally-known rows Rust lacks — an in-flight optimistic
 * send — survive).
 */
function mergeWindow(
  current: CommsMessage[] | undefined,
  incoming: CommsMessage[],
): CommsMessage[] {
  if (incoming.length === 0) return current ?? [];
  if (!current || current.length === 0) return incoming;
  const ids = new Set(incoming.map((m) => m.id));
  const extra = current.filter((m) => !ids.has(m.id));
  return extra.length === 0 ? incoming : sortBySeq([...incoming, ...extra]);
}

/** Merge a patch into one pending attachment, wherever it lives. */
function patchAttachment(
  set: (fn: (s: CommsState) => Partial<CommsState>) => void,
  convId: string,
  uploadId: string,
  patch: Partial<PendingAttachment>,
): void {
  set((s) => {
    const c = s.composers[convId];
    if (!c) return {};
    return {
      composers: {
        ...s.composers,
        [convId]: {
          ...c,
          attachments: c.attachments.map((a) => (a.uploadId === uploadId ? { ...a, ...patch } : a)),
        },
      },
    };
  });
}

/** Tell Rust a conversation is no longer displayed by ANY view, so a cold
 *  sync stops refreshing it. Windows are per-conversation, views are not. */
function releaseIfUnshown(convId: string | null, tabs: CommsTab[]): void {
  if (!convId) return;
  if (!tabs.some((t) => t.convId === convId)) {
    void comms.closeConversation(convId).catch(() => {});
  }
}

/**
 * First-page fetch for a conversation, shared by every navigation path.
 *
 * **This retries, because the failure modes here are all transient and all
 * used to be permanent.** `comms_open_conversation` rejects outright when the
 * Rust supervisor has no org target yet ("no organisation is connected") or
 * when the token mint loses a race with boot — and the old one-shot version
 * logged a warning, cleared `loading`, and left an empty transcript that
 * rendered as "this is the beginning of the channel". The only cure was
 * reopening the conversation by hand, which is exactly what people were doing.
 *
 * `loading` stays TRUE across the backoff so the UI shows a skeleton rather
 * than a lie, and `hydrated` is what finally licenses the empty-state copy.
 */
const RETRY_MS = [300, 700, 1500, 3000, 6000, 10_000, 15_000];
const convTimers = new Map<string, number>();
const convAttempts = new Map<string, number>();

function cancelConvRetry(convId: string): void {
  const t = convTimers.get(convId);
  if (t !== undefined) {
    clearTimeout(t);
    convTimers.delete(convId);
  }
}

function loadConversation(
  convId: string,
  set: (fn: (s: CommsState) => Partial<CommsState>) => void,
): void {
  cancelConvRetry(convId);
  set((s) => {
    const { [convId]: _drop, ...rest } = s.loadError;
    return { loading: { ...s.loading, [convId]: true }, loadError: rest };
  });

  void comms
    .openConversation(convId)
    .then((win) => {
      convAttempts.delete(convId);
      set((s) => ({
        messages: { ...s.messages, [convId]: mergeWindow(s.messages[convId], win.messages ?? []) },
        reactionsByMessage: mergeReactions(s.reactionsByMessage, win.reactions),
        pinned: mergePins(s.pinned, win.pinned_message_ids),
        loading: { ...s.loading, [convId]: false },
        hydrated: { ...s.hydrated, [convId]: true },
      }));
    })
    .catch((e) => {
      // Never silent: a swallowed rejection here once hid the entire
      // messages-not-loading class of bug.
      console.warn("comms: open conversation failed:", convId, e);
      const n = (convAttempts.get(convId) ?? 0) + 1;
      convAttempts.set(convId, n);

      if (n <= RETRY_MS.length) {
        // Keep `loading` set: a pending retry IS still loading, and dropping
        // it here is what made a failure look like an empty channel.
        convTimers.set(
          convId,
          window.setTimeout(
            () => {
              convTimers.delete(convId);
              loadConversation(convId, set);
            },
            RETRY_MS[n - 1],
          ),
        );
        return;
      }
      set((s) => ({
        loading: { ...s.loading, [convId]: false },
        loadError: {
          ...s.loadError,
          [convId]: typeof e === "string" ? e : "Could not load this conversation.",
        },
      }));
    });
}

/** Re-open every conversation a view is showing that has not loaded yet.
 *  Called when the socket opens — by then the org target and credential
 *  certainly exist, which is precisely what an early attempt lacked. */
export function retryUnloadedConversations(): void {
  const s = useCommsStore.getState();
  const set = useCommsStore.setState as (fn: (st: CommsState) => Partial<CommsState>) => void;
  for (const tab of s.tabs) {
    const id = tab.convId;
    if (!id || s.hydrated[id]) continue;
    convAttempts.delete(id);
    loadConversation(id, set);
  }
}

/** Non-reactive accessor, for keybinding handlers and other non-React callers. */
export const commsActions = () => useCommsStore.getState().actions;

/** Drop typing hints nobody has refreshed. There is no "stopped" frame. */
export function pruneTyping(): void {
  const cutoff = Date.now() - TYPING_EXPIRY_MS;
  const { typing } = useCommsStore.getState();
  let changed = false;
  const next: Record<string, Record<string, number>> = {};
  for (const [convId, room] of Object.entries(typing)) {
    const kept: Record<string, number> = {};
    for (const [userId, at] of Object.entries(room)) {
      if (at >= cutoff) kept[userId] = at;
      else changed = true;
    }
    if (Object.keys(kept).length) next[convId] = kept;
  }
  if (changed) useCommsStore.setState({ typing: next });
}

function sortBySeq(list: CommsMessage[]): CommsMessage[] {
  return [...list].sort((a, b) => a.seq - b.seq);
}

function withoutTyper(
  typing: Record<string, Record<string, number>>,
  convId: string,
  userId: string,
): Record<string, Record<string, number>> {
  const room = typing[convId];
  if (!room || !(userId in room)) return typing;
  const { [userId]: _gone, ...rest } = room;
  return { ...typing, [convId]: rest };
}

function mergeReads(current: ChatReadState[], incoming: ChatReadState[]): ChatReadState[] {
  const byId = new Map(current.map((r) => [r.conv_id, r]));
  for (const r of incoming) byId.set(r.conv_id, r);
  return [...byId.values()];
}

function mergeReactions(
  current: Record<string, ChatReaction[]>,
  incoming: ChatReaction[] | undefined,
): Record<string, ChatReaction[]> {
  if (!incoming?.length) return current;
  const grouped = new Map<string, ChatReaction[]>();
  for (const row of incoming) {
    const bucket = grouped.get(row.message_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.message_id, [row]);
  }
  const next = { ...current };
  for (const [messageId, rows] of grouped) next[messageId] = rows;
  return next;
}

function mergePins(current: string[], incoming: string[]): string[] {
  return [...new Set([...current.filter((id) => !incoming.includes(id)), ...incoming])];
}
