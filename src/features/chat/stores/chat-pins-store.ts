import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";
import type { ChatMessage } from "@/types/agent";
import { userMessageText } from "../lib/turn-rows";

/**
 * Pinned user messages in an agent chat — the comms pin rail, applied to the
 * agent thread. A pin is a bookmark the reader can jump back to from the
 * header dropdown; it changes nothing about the conversation itself.
 *
 * # Why the renderer owns this
 *
 * Everywhere else the house rule is that Rust owns state. A pin is the
 * exception on purpose: it is a view bookmark, not conversation data. The
 * agent never sees it, no other surface reads it, and losing one costs the
 * reader a scroll. That is `persist` to localStorage, the same trade the
 * recent-chats rail already makes — not a store file, a command and a
 * migration. (Comms pins go to the server because they are shared with other
 * humans; these are not.)
 *
 * # Scope
 *
 * Keyed by ACP session id where the session has bound, and by tab id before
 * it has (see `pinScope`). The session id is what survives a relaunch, so a
 * pin placed on a bound session is still there when the thread is resumed;
 * one placed in the first seconds of a brand-new chat is tab-scoped and does
 * not survive, which is the right way round — nothing is pinned that early.
 *
 * The pinned TEXT rides with the pin. A pin can address a message far outside
 * the loaded window (or one the transcript has not projected yet), and the
 * dropdown has to render a preview either way — the same reason the comms
 * rail carries each message with its pin rather than reading the store.
 */
export interface ChatPin {
  /** `ChatMessage.id` at pin time. Row ids are `u:<messageId>`; the raw id is
   *  stored. NOT durable — see `resolvePinIndex`. */
  messageId: string;
  /** The message's own timestamp. Survives everything the id does not. */
  timestamp: string;
  /** Cleaned prompt text — the dropdown preview AND half of the durable key. */
  text: string;
  /** ISO timestamp of the pin itself, for the `timeAgo` stamp. */
  at: string;
}

/**
 * Where a pin's message sits in `messages` now, or -1.
 *
 * The id is tried first but cannot be relied on: `replaceMessages` re-mints
 * every id as `msg-<now>-<i>` on each history load, resume and snapshot
 * backfill, so a pin can point at an id no message carries. The fallback is
 * the text the bubble SHOWS — `userMessageText`, the same derivation the pin
 * recorded — compared for equality. Not the wire content: a prompt arrives
 * with memory blocks injected AHEAD of it and a directive after, so neither
 * equality nor a prefix against `m.content` ever matched.
 *
 * Timestamp breaks ties between identical prompts where it survived; text
 * alone is the last resort for a timestamp the paint path invented
 * (`m.timestamp ?? now`). User messages only — the same prose in an assistant
 * reply must not hijack the jump.
 */
export function resolvePinIndex(messages: ReadonlyArray<ChatMessage>, pin: ChatPin): number {
  let byStamp = -1;
  let byText = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.id === pin.messageId) return i;
    if (m.role !== "user") continue;
    if (byStamp >= 0) continue;
    if (userMessageText(m) !== pin.text) continue;
    if (m.timestamp === pin.timestamp) byStamp = i;
    else if (byText < 0) byText = i;
  }
  return byStamp >= 0 ? byStamp : byText;
}

/** Per-scope cap. Pins are a shortlist; an unbounded one is a second thread. */
const CAP = 50;

interface ChatPinsState {
  /** scope key → pins, newest first. */
  pins: Record<string, ChatPin[]>;
  actions: {
    toggle: (scope: string, pin: ChatPin) => void;
    unpin: (scope: string, messageId: string) => void;
  };
}

export const useChatPinsStore = createSelectors(
  create<ChatPinsState>()(
    persist(
      (set) => ({
        pins: {},
        actions: {
          toggle: (scope, pin) =>
            set((s) => {
              const current = s.pins[scope] ?? [];
              const without = current.filter((p) => p.messageId !== pin.messageId);
              const next =
                without.length === current.length ? [pin, ...without].slice(0, CAP) : without;
              return { pins: { ...s.pins, [scope]: next } };
            }),
          unpin: (scope, messageId) =>
            set((s) => ({
              pins: {
                ...s.pins,
                [scope]: (s.pins[scope] ?? []).filter((p) => p.messageId !== messageId),
              },
            })),
        },
      }),
      {
        name: "atlas-chat-pins",
        version: 1,
        partialize: (s) => ({ pins: s.pins }),
      },
    ),
  ),
);

/**
 * The scope key for a chat tab.
 *
 * Resolved by the transcript and the panel — never by a row, which must not
 * subscribe to the chat store (house rule 3).
 */
export function pinScope(tabId: string, acpSessionId: string | undefined): string {
  return acpSessionId ? `s:${acpSessionId}` : `t:${tabId}`;
}

/** Pins for one scope, or a stable empty array — `[]` literals in a selector
 *  are a new identity every call and would re-render on every store write. */
const EMPTY: ChatPin[] = [];
export function pinsFor(state: ChatPinsState, scope: string): ChatPin[] {
  return state.pins[scope] ?? EMPTY;
}
