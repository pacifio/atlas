import { useMemo } from "react";

import { useChatStore } from "../stores/chat-store";
import { orderedSubagents } from "../lib/subagents";
import type { Subagent } from "@/types/agent";

/*
 * Reading a session's delegated children.
 *
 * Every hook here subscribes to ONE store field and derives the rest with
 * `useMemo` over that reference. That is deliberate and not a style choice:
 * immer gives `session.subagents` a new identity only when something in it
 * changed, so the subscription compares with `Object.is` and settles. A
 * selector that built the array itself — `(s) => orderedSubagents(...)` — would
 * allocate on every call and re-render forever, with or without `useShallow`,
 * which is one level deep and cannot see into records of objects.
 *
 * Nothing here ticks. A live child's elapsed time belongs to the frame that
 * paints it: use the `LiveElapsed` pattern in `transcript-rows.tsx`, which
 * writes the figure straight to the DOM once a second and skips React
 * entirely. Putting `Date.now()` in this layer would re-render every subagent
 * row every second for a number only one span shows.
 */

const NO_SUBAGENTS: readonly Subagent[] = Object.freeze([]);

/**
 * Every child this tab's session has delegated to, in launch order.
 *
 * Not per-turn: an earlier turn's children stay here, anchored to the message
 * that launched them, until the transcript itself is replaced. Empty for the
 * overwhelming majority of sessions — a surface should render nothing at all
 * rather than an empty container.
 */
export function useSubagents(tabId: string | null | undefined): readonly Subagent[] {
  const map = useChatStore((s) => (tabId ? s.sessions[tabId]?.subagents : undefined));
  return useMemo(() => (map ? orderedSubagents(map) : NO_SUBAGENTS), [map]);
}

/** One child by its launching call id, for a detail view opened on a row. */
export function useSubagent(
  tabId: string | null | undefined,
  toolCallId: string | null | undefined,
): Subagent | undefined {
  return useChatStore((s) =>
    tabId && toolCallId ? s.sessions[tabId]?.subagents?.[toolCallId] : undefined,
  );
}
