import { useEffect, useRef, type RefObject } from "react";
import type { ChatSession } from "@/types/agent";
import type { ImageAttachment } from "@/types/agents";
import { useChatStore } from "../stores/chat-store";
import type { MentionData } from "../lib/mentions";
import { drainEdge } from "../lib/drain-gate";
import { flushLocalQueue, setQueueHold, syncQueuePause } from "../lib/turn-queue";
import { CHAT_STOP_EVENT, isSwitchPending } from "../lib/switch-agent";

/** The panel's current send handler, reassigned every render. */
export type ChatSendHandler = (
  content: string,
  mentions: MentionData[],
  attachments?: ImageAttachment[],
  opts?: { recorded?: boolean; clientMessageId?: string },
) => Promise<void> | void;

interface QueueDrainArgs {
  tabId: string;
  session: ChatSession | undefined;
  /** A session another process is writing (ADR-0001 amendment, Rule 7). */
  heldElsewhere: boolean;
  /** The no-AI-grant hold on the queue (`drain-gate.ts`). */
  grantHold: boolean;
  handleSendRef: RefObject<ChatSendHandler | null>;
  releaseQueueRef: RefObject<(() => Promise<void>) | null>;
}

export function useQueueDrain({
  tabId,
  session,
  heldElsewhere,
  grantHold,
  handleSendRef,
  releaseQueueRef,
}: QueueDrainArgs): void {
  // Drain the per-tab queue when the agent transitions back to idle OR
  // when the ACP session id first becomes available. The latter covers the
  // "user typed and hit Send before the bind landed" case — submit pushes
  // onto the queue and this effect flushes it the moment the binding
  // appears, no error message, no lost message.
  const prevStatusRef = useRef<string | null>(null);
  const prevAcpRef = useRef<string | undefined>(undefined);
  const prevResumingRef = useRef(false);
  // A session another process is writing (ADR-0001 amendment, Rule 7) closes
  // the drain gate like a pending resume does; "Send anyway" or the other
  // process going quiet is its falling edge.
  const prevHeldElsewhereRef = useRef(false);
  const prevGrantHoldRef = useRef(grantHold);
  useEffect(() => {
    const cur = session?.status ?? "idle";
    const prev = prevStatusRef.current;
    prevStatusRef.current = cur;
    const curAcp = session?.acpSessionId;
    const prevAcp = prevAcpRef.current;
    prevAcpRef.current = curAcp;
    // A resumed session is bound optimistically, so `acpSessionId` appears long
    // before the backend can accept a prompt. Track the resume flag separately —
    // its falling edge is the real "sendable now" signal for that path.
    // A mode a resume could not restore holds the gate the same way, until the
    // user picks one (`resume-mode.ts`).
    const curResuming = !!session?.resumePending || !!session?.unrestoredModeId;
    const prevResuming = prevResumingRef.current;
    prevResumingRef.current = curResuming;
    const prevHeldElsewhere = prevHeldElsewhereRef.current;
    prevHeldElsewhereRef.current = heldElsewhere;
    const prevGrantHold = prevGrantHoldRef.current;
    prevGrantHoldRef.current = grantHold;
    // The gate lives in `drain-gate.ts` with its own test: a queue drains
    // only into a BOUND session. The bind-failure branch above parks the held
    // message back in the queue and drops the status to idle, and reading
    // that edge as "turn finished" re-dispatched the message into the unbound
    // tab — which re-held it, re-kicked the bind, and looped (491 connect
    // attempts in a minute, a bubble and a toast per cycle) until Stop.
    const { justBound, justResumed, drainQueue } = drainEdge({
      prevStatus: prev,
      curStatus: cur,
      prevAcp,
      curAcp,
      prevResuming,
      curResuming,
      prevHeldElsewhere,
      curHeldElsewhere: heldElsewhere,
      prevGrantHold,
      curGrantHold: grantHold,
    });
    if (justBound || justResumed) {
      // The first message held while the session was starting goes out
      // ahead of the queue — it was recorded in the transcript at send time,
      // so it is dispatched without being recorded again. Anything typed
      // meanwhile is handed to the session's queue after it, parked: Rust
      // drains it when that first turn ends.
      const state = useChatStore.getState();
      const held = state.sessions[tabId]?.pendingSend;
      if (held) {
        state.actions.setPendingSend(tabId, undefined);
        Promise.resolve()
          .then(() =>
            handleSendRef.current?.(held.content, held.mentions, held.attachments, {
              recorded: true,
              clientMessageId: held.clientMessageId,
            }),
          )
          .then(() => flushLocalQueue(tabId, { drain: false }));
        return;
      }
    }
    // The queue is Rust's (the turn controller drains it when a turn ends);
    // what is left here is handing it what only the window knows. A switch
    // waiting on `/remember` holds the queue: what was typed during the save
    // is for the agent the tab switches to (`switch-agent.ts`).
    if (drainQueue && !isSwitchPending(tabId)) {
      // Defer one microtask so the React commit completes first.
      Promise.resolve().then(() => releaseQueueRef.current?.());
    }
    // Next-step chips are extracted from the agent's own `<next_steps>` block in
    // the chat-store `turn_finished` reducer — nothing to do here.
  }, [
    session?.status,
    session?.acpSessionId,
    session?.resumePending,
    session?.unrestoredModeId,
    heldElsewhere,
    grantHold,
    tabId,
  ]);

  // The window's send gates hold the session's queue in Rust: a resume still
  // loading, a mode it could not restore, a session another process is
  // writing, the no-AI-grant lock. Rust drains nothing while held, and drains
  // an idle session's head the moment the last hold lifts — the falling edges
  // `drainEdge` used to drain the React queue on. Re-told on every rebind: a
  // new session starts unpaused.
  useEffect(() => {
    const gated =
      !!session?.resumePending || !!session?.unrestoredModeId || heldElsewhere || grantHold;
    setQueueHold(tabId, "gate", gated);
    syncQueuePause(tabId);
  }, [
    tabId,
    session?.acpSessionId,
    session?.resumePending,
    session?.unrestoredModeId,
    session?.disconnected,
    heldElsewhere,
    grantHold,
  ]);
}

/** Window events addressed to this panel: a send from outside the composer
 *  (`atlas:chat-send`) and a stop from outside it (`CHAT_STOP_EVENT`). */
export function useChatPanelEvents(
  tabId: string,
  handleSendRef: RefObject<ChatSendHandler | null>,
  handleStopRef: RefObject<(() => void) | null>,
): void {
  // Suggestion chips (and other adaptive affordances) send as the next message.
  // This is a GLOBAL window event and every mounted ChatPanel hears it, so only
  // act when the event is addressed to THIS tab (the chip stamps its origin
  // tabId). A tabId-less event (none today) still falls through to all, matching
  // the prior behaviour.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string; tabId?: string }>).detail;
      if (detail?.tabId != null && detail.tabId !== tabId) return;
      if (detail?.text && handleSendRef.current) {
        handleSendRef.current(detail.text, []);
      }
    };
    window.addEventListener("atlas:chat-send", handler);
    return () => window.removeEventListener("atlas:chat-send", handler);
  }, [tabId]);

  // Stop this tab's turn from outside the composer — an agent switch that
  // waited on `/remember` and now switches in place (`switch-agent.ts`). Only
  // ever addressed to one tab.
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent<{ tabId?: string }>).detail?.tabId !== tabId) return;
      handleStopRef.current?.();
    };
    window.addEventListener(CHAT_STOP_EVENT, handler);
    return () => window.removeEventListener(CHAT_STOP_EVENT, handler);
  }, [tabId]);
}
