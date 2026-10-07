import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import {
  NATIVE_AGENT,
  isBusyAgentStatus,
  type PendingSend,
  type SwitchableAgent,
} from "@/types/agent";
import { agentMeta, switchableAgentIds } from "@/features/agents/lib/agent-meta";
import type { MentionPastSession } from "./mentions";
import { openAgentChatInNewTab } from "./open-agent-session";
import {
  REMEMBER_COMMAND,
  REMEMBER_MESSAGE,
  advertisesCommand,
  awaitTurnEnd,
  type TurnEnd,
} from "./remember";
import { projectPathForTab } from "./tab-project";

/** The window event a handoff fires; the composer of `tabId` inserts the
 *  previous conversation as a past-session chip. */
export const SESSION_HANDOFF_EVENT = "atlas:chat-handoff-session";

/** Ask the chat panel of `detail.tabId` to stop its running turn, the same as
 *  its Stop button. */
export const CHAT_STOP_EVENT = "atlas:chat-stop";

export interface SessionHandoffDetail {
  tabId: string;
  mention: MentionPastSession;
}

/**
 * Bind a chat tab to a different coding agent — the single implementation
 * behind every entry point (⌥/ cycle, the composer's agent pill, the "+" menu
 * picker), so they can never drift apart.
 *
 * A session is paired to ONE agent for its lifetime, so switching means a fresh
 * session. The cases:
 * - empty chat  → flip the agent in place, nothing to lose.
 * - idle chat   → the user's `agentSwitchBehavior` setting decides:
 *                 "reset" (default) switches in place and starts over;
 *                 "new-tab" leaves it on screen and opens a fresh tab on the
 *                 new agent; "handoff" switches in place and attaches the
 *                 conversation to the composer as a past-session chip, so the
 *                 new agent receives it with the next message. Either way the
 *                 old conversation is persisted per-turn and stays in history.
 * - BUSY chat   → leave it completely alone and open a fresh tab on the new
 *                 agent. Clearing here would orphan the live turn: its deltas
 *                 would find no tab, Stop would vanish, and it would keep
 *                 running invisibly.
 * - STARTING     → the one busy case that IS switched in place: `running` only
 *                 because a first message is held on a bind that has not landed
 *                 (`pendingSend`, no `acpSessionId`). Nothing is streaming and
 *                 no backend turn exists, so there is nothing to orphan — and a
 *                 stuck start is exactly when the user reaches for ⌥/. The held
 *                 message is carried over: re-recorded as the new session's
 *                 first bubble and re-held, so the new bind dispatches it.
 *
 * With `rememberBeforeSwitch` on, an idle chat with a conversation whose agent
 * advertises `/remember` is sent that command first, and the switch above runs
 * once that turn ends (`rememberThenSwitch`). A pick made while that save is
 * pending replaces the pending switch rather than starting a second one.
 *
 * `opts.afterRemember` is that deferred switch running: the save is over, so
 * it is not asked for again. `"sent"` means the `/remember` turn reached the
 * conversation, so a handoff leaves it out of the attached transcript.
 * `opts.typed` is what the user typed while the save ran: on an in-place
 * switch the first message goes out on the new bind, carrying the handoff when
 * there is one, and the rest queue behind it.
 */
export function switchAgentForTab(
  tabId: string,
  next: SwitchableAgent,
  opts: { afterRemember?: "sent" | "unsent"; typed?: string[] } = {},
): void {
  const pending = pendingSwitches.get(tabId);
  if (pending && !opts.afterRemember) {
    retargetPendingSwitch(pending, next);
    return;
  }
  const chat = useChatStore.getState();
  const sess = chat.sessions[tabId];
  if ((sess?.agentType ?? NATIVE_AGENT) === next) return;

  const startingOnly = isStartingOnly(sess);
  if (!startingOnly && isBusyAgentStatus(sess?.status)) {
    openAgentChatInNewTab(next);
    return;
  }
  // `rememberBeforeSwitch`: the agent being left records what it learned in
  // shared memory first, then the switch runs as configured. Only for a bound
  // conversation (there is an agent to ask) whose agent offers `/remember`:
  // what it advertises over ACP is the capability (ADR-0002), whichever agent
  // it is and wherever the skill came from.
  if (
    !opts.afterRemember &&
    !startingOnly &&
    (sess?.messages.length ?? 0) > 0 &&
    sess?.acpSessionId &&
    useSettingsStore.getState().settings.rememberBeforeSwitch &&
    advertisesCommand(sess, REMEMBER_COMMAND)
  ) {
    void rememberThenSwitch(tabId, sess.agentType ?? NATIVE_AGENT, next);
    return;
  }
  let handoff: MentionPastSession | undefined;
  if (!startingOnly && (sess?.messages.length ?? 0) > 0) {
    const behavior = useSettingsStore.getState().settings.agentSwitchBehavior;
    // A handoff needs the transcript Atlas recorded under the bound session;
    // without one there is nothing to attach, so keep the conversation instead.
    if (behavior === "new-tab" || (behavior === "handoff" && !sess?.acpSessionId)) {
      openAgentChatInNewTab(next);
      return;
    }
    if (behavior === "handoff" && sess?.acpSessionId) {
      const title = sess.title && sess.title !== "New Chat" ? sess.title : "Previous session";
      handoff = {
        kind: "past_session",
        id: sess.acpSessionId,
        displayName: title,
        sessionId: sess.acpSessionId,
        sessionTitle: title,
        cwd: sess.workingDirectory || projectPathForTab(tabId) || "",
        // The save request and the agent's list of what it saved are not
        // part of the conversation being handed over: read as a live request,
        // they would have the new agent save everything again.
        ...(opts.afterRemember === "sent" ? { endBeforeRemember: true } : {}),
      };
    }
  }
  const previousAgent = sess?.agentType ?? NATIVE_AGENT;
  const [firstTyped, ...restTyped] = opts.typed ?? [];
  const held: PendingSend | undefined = startingOnly
    ? sess?.pendingSend
    : firstTyped === undefined
      ? undefined
      : { content: firstTyped, mentions: handoff ? [handoff] : [] };
  if ((sess?.messages.length ?? 0) > 0) {
    chat.actions.clearSession(tabId);
  }
  chat.actions.switchChatAgent(tabId, next);
  if (held) {
    // Same shape as the composer's first-while-starting send: bubble first,
    // title from the text, status running, prompt held on the session.
    const { actions } = useChatStore.getState();
    actions.addMessage(tabId, "user", held.content, held.attachments);
    actions.setSessionTitle(
      tabId,
      held.content.slice(0, 40) + (held.content.length > 40 ? "..." : ""),
    );
    actions.updateSessionStatus(tabId, "running");
    actions.setPendingSend(tabId, held);
    for (const text of restTyped) actions.enqueueMessage(tabId, text);
  }
  if (handoff && firstTyped !== undefined) {
    toast(
      `${agentMeta(previousAgent).label} conversation handed to ${agentMeta(next).label} with your message.`,
    );
  } else if (handoff) {
    const detail: SessionHandoffDetail = { tabId, mention: handoff };
    window.dispatchEvent(new CustomEvent(SESSION_HANDOFF_EVENT, { detail }));
    toast(
      `${agentMeta(previousAgent).label} conversation attached. Your next message hands it to ${agentMeta(next).label}.`,
    );
  }
  window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
}

/** Longest a pre-switch `/remember` turn is waited on before switching anyway. */
export const REMEMBER_BEFORE_SWITCH_TIMEOUT_MS = 3 * 60_000;
/** How long the sent `/remember` may take to start: a send nobody picked up
 *  (no chat panel for the tab) must not hold the switch for three minutes. */
export const REMEMBER_START_TIMEOUT_MS = 15_000;
/** How long a stopped `/remember` turn may take to wind down before an
 *  in-place switch gives up and falls back to the busy rule (a new tab). */
export const REMEMBER_STOP_GRACE_MS = 10_000;

/** A switch waiting on the `/remember` turn of the agent being left. One per
 *  tab: a second pick changes `next` instead of queueing another switch. */
interface PendingSwitch {
  from: string;
  next: SwitchableAgent;
  toastId: string | number;
  /** Aborted by "Switch now", and by a pick of the agent the tab is on. */
  waiting: AbortController;
  /** The user picked the agent the tab is already on: no switch at all. */
  cancelled: boolean;
}

const pendingSwitches = new Map<string, PendingSwitch>();

/** Whether a switch on `tabId` is waiting on its `/remember` turn. The chat
 *  panel holds the tab's queue meanwhile: a message typed during the save goes
 *  to whichever agent the tab is on once the switch is done, not to the one
 *  being left (`rememberThenSwitch`). */
export function isSwitchPending(tabId: string): boolean {
  return pendingSwitches.has(tabId);
}

/** Send the head of a queue the chat panel held during a pending switch, if
 *  the tab can take it now: bound, idle and not resuming. The rest drains
 *  after that turn as usual. An unbound tab (switched in place) needs nothing:
 *  its bind drains the queue. */
function releaseHeldQueue(tabId: string): void {
  const { sessions, queues, actions } = useChatStore.getState();
  const sess = sessions[tabId];
  if (!sess?.acpSessionId || sess.resumePending || isBusyAgentStatus(sess.status)) return;
  if (!queues[tabId]?.length) return;
  const text = actions.shiftQueue(tabId);
  if (text) window.dispatchEvent(new CustomEvent("atlas:chat-send", { detail: { tabId, text } }));
}

/** The "saving…" notice for a pending switch; with `id`, updates it in place. */
function showSavingToast(pending: PendingSwitch, id?: string | number): string | number {
  return toast.loading(`Saving to memory before switching to ${agentMeta(pending.next).label}…`, {
    ...(id === undefined ? {} : { id }),
    action: { label: "Switch now", onClick: () => pending.waiting.abort() },
  });
}

/** A pick made while a switch waits on `/remember`: retarget that switch, or
 *  call it off when the pick is the agent the tab is already on. */
function retargetPendingSwitch(pending: PendingSwitch, next: SwitchableAgent): void {
  if (next === pending.from) {
    pending.cancelled = true;
    pending.waiting.abort();
    return;
  }
  pending.next = next;
  showSavingToast(pending, pending.toastId);
}

/** Whether `tabId` still exists and is still bound to `agent`. */
function stillOn(tabId: string, agent: string): boolean {
  const sess = useChatStore.getState().sessions[tabId];
  return !!sess && (sess.agentType ?? NATIVE_AGENT) === agent;
}

/** Stop the tab's running turn (as its Stop button does) and wait a little for
 *  it to end. A Stop already pending is not pressed again: a second press
 *  escalates to killing the agent. */
async function stopTurn(tabId: string): Promise<void> {
  const sess = useChatStore.getState().sessions[tabId];
  if (!sess || !isBusyAgentStatus(sess.status)) return;
  // Subscribed before the Stop: the turn may end inside the dispatch.
  const ended = awaitTurnEnd(tabId, { timeoutMs: REMEMBER_STOP_GRACE_MS });
  if (!sess.stopping) window.dispatchEvent(new CustomEvent(CHAT_STOP_EVENT, { detail: { tabId } }));
  await ended;
}

/** What the user is told when the save did not complete; null when it did. */
function saveProblem(end: TurnEnd, from: string, next: SwitchableAgent): string | null {
  const f = agentMeta(from).label;
  const n = agentMeta(next).label;
  switch (end) {
    case "failed":
      return `${f} could not save to memory: its turn ended in an error. Switching to ${n}.`;
    case "timeout":
      return `${f} did not finish saving to memory within 3 minutes. Switching to ${n}.`;
    case "not-started":
      return `Could not ask ${f} to save to memory. Switching to ${n}.`;
    default:
      return null;
  }
}

/**
 * Send `/remember` to the agent being left, wait for that turn to end, then
 * switch as `agentSwitchBehavior` says.
 *
 * The turn can still be running when the wait ends: the toast's "Switch now",
 * or the timeout. "new-tab" leaves it running beside the new tab. "reset" and
 * "handoff" switch in place, which would orphan a live turn, so the turn is
 * stopped first; one that will not stop falls back to the busy rule (a new
 * tab), and the user is told.
 */
async function rememberThenSwitch(
  tabId: string,
  from: string,
  next: SwitchableAgent,
): Promise<void> {
  const pending: PendingSwitch = {
    from,
    next,
    toastId: "",
    waiting: new AbortController(),
    cancelled: false,
  };
  pending.toastId = showSavingToast(pending);
  pendingSwitches.set(tabId, pending);
  try {
    window.dispatchEvent(
      new CustomEvent("atlas:chat-send", { detail: { tabId, text: REMEMBER_MESSAGE } }),
    );
    const end = await awaitTurnEnd(tabId, {
      timeoutMs: REMEMBER_BEFORE_SWITCH_TIMEOUT_MS,
      startTimeoutMs: REMEMBER_START_TIMEOUT_MS,
      signal: pending.waiting.signal,
    });
    // Gone, called off, or switched by other means meanwhile: nothing to do.
    if (end === "gone" || pending.cancelled || !stillOn(tabId, from)) return;
    const problem = saveProblem(end, from, pending.next);
    if (problem) toast.error(problem);
    const behavior = useSettingsStore.getState().settings.agentSwitchBehavior;
    if (
      behavior !== "new-tab" &&
      isBusyAgentStatus(useChatStore.getState().sessions[tabId]?.status)
    ) {
      await stopTurn(tabId);
      if (pending.cancelled || !stillOn(tabId, from)) return;
      if (isBusyAgentStatus(useChatStore.getState().sessions[tabId]?.status)) {
        toast.error(
          `${agentMeta(from).label} is still saving to memory, so ${agentMeta(pending.next).label} opens in a new tab.`,
        );
      }
    }
    // Messages typed during the save are for the agent the tab ends up on. An
    // in-place switch clears the session, queue included, so they are taken
    // out and handed to the switch; when a new tab opened instead, they go
    // back to this tab.
    const { queues, actions } = useChatStore.getState();
    const typed = queues[tabId] ?? [];
    if (typed.length) actions.clearQueue(tabId);
    switchAgentForTab(tabId, pending.next, {
      afterRemember: end === "not-started" ? "unsent" : "sent",
      typed,
    });
    if (stillOn(tabId, from)) {
      for (const text of typed) useChatStore.getState().actions.enqueueMessage(tabId, text);
    }
  } finally {
    pendingSwitches.delete(tabId);
    toast.dismiss(pending.toastId);
    releaseHeldQueue(tabId);
  }
}

/** "Busy" only in the sense that a first message is waiting on a bind that
 *  has not produced a session yet. Exported for the composer's stall
 *  affordance, which offers the switch in exactly this state. */
export function isStartingOnly(
  sess: { status?: string; pendingSend?: unknown; acpSessionId?: string } | undefined,
): boolean {
  return !!sess && sess.status === "running" && !!sess.pendingSend && !sess.acpSessionId;
}

/** The next agent in the ⌥/ rotation for a tab — first-party agents in their
 *  fixed order, then any installed registry externals. */
function nextAgentForTab(tabId: string): SwitchableAgent {
  const rotation = switchableAgentIds();
  const cur = useChatStore.getState().sessions[tabId]?.agentType;
  const idx = rotation.indexOf(cur ?? NATIVE_AGENT);
  return rotation[(Math.max(idx, 0) + 1) % rotation.length];
}

/** Advance a chat tab to the next agent (⌥/ and the composer's agent pill). */
export function cycleChatAgent(tabId: string): void {
  switchAgentForTab(tabId, nextAgentForTab(tabId));
}
