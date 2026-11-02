/**
 * The window's side of a session's prompt queue.
 *
 * The queue belongs to the session, in Rust — the turn controller beside
 * `AgentHost` (`src-tauri/src/commands/agent_host/steering.rs`). It drains the
 * next prompt when a turn ends, discards the queue on Stop, and announces every
 * change as a whole-queue `queue_changed` delta, which the chat store mirrors
 * into `queues[tabId]` (what the composer's queued-message strip renders). It
 * used to be React state drained by a React effect, which a remote driver
 * could not reach and a closed tab took with it.
 *
 * Two kinds of item live in the strip, told apart by `queueIds[tabId]`:
 *
 * - **Mirrored** (a Rust item id) — the session is bound, and Rust has it.
 * - **Local** (`null`) — typed while the tab has no session Rust can hold a
 *   queue for (still starting, a resume loading, the agent process gone).
 *   Flushed into Rust, in order, at the next bind.
 *
 * Plus `pending:` markers: an add that is on its way to Rust, shown at once
 * and replaced by the delta (or turned local if the add failed).
 *
 * The window's send gates — a resume still loading, a mode it could not
 * restore, a session live in another process, no AI grant, an agent switch
 * waiting on `/remember` — pause the Rust queue rather than holding items
 * back here (`setQueueHold`), so the drain decision stays in one place.
 */
import { useChatStore } from "../stores/chat-store";
import { agents } from "./agents-api";
import { appendNextStepsDirective } from "./next-steps";
import type { MentionData } from "./mentions";
import { inlineQueuedText } from "./queued-text";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { SessionKey } from "@/types/agents";

const PENDING = "pending:";
let pendingSeq = 0;

/** A strip item whose add has not been confirmed yet. */
export const isPendingQueueId = (id: string | null | undefined): boolean =>
  !!id && id.startsWith(PENDING);

/** The session Rust can hold this tab's queue for, or `null` while there is
 *  none: unbound, a resume not yet loaded, or the agent process gone. */
export function queueKey(tabId: string): SessionKey | null {
  const s = useChatStore.getState().sessions[tabId];
  if (!s?.acpAgentId || !s.acpSessionId || s.resumePending || s.disconnected) return null;
  return { agent_id: s.acpAgentId, session_id: s.acpSessionId };
}

/** What the agent is sent for a queued prompt: what was typed, plus the hidden
 *  next-steps directive when that setting is on — what a direct send of the
 *  same text sends (`ChatPanel.handleSend`). `text` is already inlined
 *  (`inlineQueuedText`): queued prompts carry no structured mentions. */
export function queuedWirePrompt(text: string): string {
  return useSettingsStore.getState().settings.adaptiveSuggestions !== "off"
    ? appendNextStepsDirective(text)
    : text;
}

/** Pending markers removed from the strip before Rust confirmed them: when the
 *  add lands, it is taken back out. */
const withdrawn = new Set<string>();

/** Park `text` behind the running turn. Bound: into Rust's queue (shown at
 *  once, confirmed by `queue_changed`). Not bound: held locally until the
 *  bind. Never sent by itself — Rust drains it when the turn ends. */
export function enqueuePrompt(tabId: string, text: string, mentions: readonly MentionData[]): void {
  const { actions } = useChatStore.getState();
  const key = queueKey(tabId);
  if (!key) {
    actions.enqueueMessage(tabId, text, mentions);
    return;
  }
  const marker = `${PENDING}${++pendingSeq}`;
  actions.enqueueMessage(tabId, text, mentions, marker);
  void addToRust(tabId, key, inlineQueuedText(text, mentions), marker);
}

async function addToRust(
  tabId: string,
  key: SessionKey,
  text: string,
  marker: string,
): Promise<boolean> {
  try {
    const id = await agents.queueAdd(key, text, queuedWirePrompt(text));
    if (withdrawn.delete(marker)) {
      if (typeof id === "string") void agents.queueRemove(key, id).catch(() => {});
      return true;
    }
    // Normally the delta has already replaced the marker; this covers a delta
    // that never came (the session's projection closed meanwhile).
    if (typeof id === "string") useChatStore.getState().actions.setQueueItemId(tabId, marker, id);
    return true;
  } catch (err) {
    console.warn("queue add failed; keeping the prompt locally:", err);
    withdrawn.delete(marker);
    // Local: flushed into Rust at the next bind, never lost.
    useChatStore.getState().actions.setQueueItemId(tabId, marker, null);
    return false;
  }
}

/** Take the strip's `index`-th item out (its chip's ✕, or "edit"). */
export function removeQueuedPrompt(tabId: string, index: number): void {
  const state = useChatStore.getState();
  const id = state.queueIds[tabId]?.[index] ?? null;
  state.actions.removeQueueItem(tabId, index);
  if (!id) return;
  if (isPendingQueueId(id)) {
    withdrawn.add(id);
    return;
  }
  const key = queueKey(tabId);
  if (key) void agents.queueRemove(key, id).catch(() => {});
}

/** Discard everything queued for the tab — Rust's queue and any local items —
 *  leaving a running turn alone. */
export function clearQueuedPrompts(tabId: string): void {
  const state = useChatStore.getState();
  for (const id of state.queueIds[tabId] ?? []) if (isPendingQueueId(id)) withdrawn.add(id!);
  state.actions.clearQueue(tabId);
  const key = queueKey(tabId);
  if (key) void agents.queueClear(key).catch(() => {});
}

/** Take every queued prompt's text out of the queue (an agent switch hands
 *  them to the agent the tab ends up on). */
export function takeQueuedPrompts(tabId: string): string[] {
  const texts = [...(useChatStore.getState().queues[tabId] ?? [])];
  if (texts.length) clearQueuedPrompts(tabId);
  return texts;
}

/** Hand the bound session every local item, in order, then — with `drain` —
 *  start the head if the session is idle and its queue not paused. A no-op
 *  for a tab Rust cannot hold a queue for yet. */
export async function flushLocalQueue(tabId: string, opts: { drain: boolean }): Promise<void> {
  const key = queueKey(tabId);
  if (!key) return;
  const state = useChatStore.getState();
  const texts = state.queues[tabId] ?? [];
  const ids = state.queueIds[tabId] ?? [];
  const local: Array<{ text: string; marker: string }> = [];
  texts.forEach((text, i) => {
    if (ids[i] === null || ids[i] === undefined) {
      const marker = `${PENDING}${++pendingSeq}`;
      state.actions.setQueueItemIdAt(tabId, i, marker);
      local.push({ text, marker });
    }
  });
  // One at a time: the queue's order is the order they were typed in.
  for (const { text, marker } of local) {
    if (!(await addToRust(tabId, key, text, marker))) return;
  }
  if (opts.drain) await agents.queueDrain(key).catch(() => null);
}

/** Every item the strip shows becomes local: the session the ids named is
 *  gone (an agent restart that could not resume it), so the next flush hands
 *  them to the new one. */
export function adoptQueueAsLocal(tabId: string): void {
  useChatStore.getState().actions.setAllQueueItemsLocal(tabId);
}

// ── The drain gate ──────────────────────────────────────────────────────────

/** Why each tab's queue is held, by reason ("gate", "switch"). */
const holdReasons = new Map<string, Set<string>>();
/** The last pause state told to Rust, per tab, as `session:paused`. */
const pushedPause = new Map<string, string>();

/** Hold (`on`) or release the tab's queue for `reason`. While any reason
 *  holds it, Rust does not drain; the last release drains an idle session. */
export function setQueueHold(tabId: string, reason: string, on: boolean): void {
  const reasons = holdReasons.get(tabId) ?? new Set<string>();
  if (on) reasons.add(reason);
  else reasons.delete(reason);
  if (reasons.size === 0) holdReasons.delete(tabId);
  else holdReasons.set(tabId, reasons);
  syncQueuePause(tabId);
}

/** Whether anything holds the tab's queue. */
export function isQueueHeld(tabId: string): boolean {
  return (holdReasons.get(tabId)?.size ?? 0) > 0;
}

/** Tell Rust the tab's current pause state, if it differs from what it was
 *  last told for this session — called on every hold change and every rebind
 *  (a new session starts unpaused). */
export function syncQueuePause(tabId: string): void {
  const key = queueKey(tabId);
  if (!key) return;
  const paused = isQueueHeld(tabId);
  const sig = `${key.session_id}:${paused}`;
  if (pushedPause.get(tabId) === sig) return;
  pushedPause.set(tabId, sig);
  void agents.queuePause(key, paused).catch(() => {
    if (pushedPause.get(tabId) === sig) pushedPause.delete(tabId);
  });
}

/** Forget a closed tab's gate bookkeeping. */
export function forgetQueueHolds(tabId: string): void {
  holdReasons.delete(tabId);
  pushedPause.delete(tabId);
}
