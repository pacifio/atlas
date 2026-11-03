import type { Dispatch, RefObject, SetStateAction } from "react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { noteSessionSent } from "@/features/tips/lib/session-sent";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { logEvent } from "@/features/log/lib/log";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { ImageAttachment, SessionKey } from "@/types/agents";
import { isBusyAgentStatus, pluginIdForAgent, type ChatSession } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { isSendHeldElsewhere } from "../stores/live-elsewhere-store";
import { useSessionProjectsStore } from "../stores/session-projects-store";
import { useRcStore } from "../stores/rc-store";
import type { BindControl } from "../hooks/use-agent-bind";
import { agents, resetAgent } from "./agents-api";
import { rebindDisconnectedSession } from "./agent-rebind";
import { projectPathForTab } from "./tab-project";
import { appendNextStepsDirective } from "./next-steps";
import {
  adoptQueueAsLocal,
  clearQueuedPrompts,
  enqueuePrompt,
  flushLocalQueue,
} from "./turn-queue";
import { attachMentionedProjects, isProjectMention } from "./attach-mentioned-projects";
import { cycleChatAgent } from "./switch-agent";
import { drivenElsewhere } from "./rc-api";
import { errInfo } from "./agent-signin";
import { composePrompt, type MentionData } from "./mentions";
import { trustedMentionPaths } from "./picked-mentions";
import { withCitesInline } from "./cited-text";
import { withReviewCommentsInline } from "./review-comments";

type ChatActions = ReturnType<typeof useChatStore.getState>["actions"];

interface ChatPanelHandlerContext {
  tabId: string;
  /** The render's session — `handleSend` titles the session from it. */
  session: ChatSession;
  /** The no-AI-grant hold on the queue (`drain-gate.ts`). */
  grantHold: boolean;
  bindControlRef: RefObject<BindControl | null>;
  setBindEpoch: Dispatch<SetStateAction<number>>;
  addMessage: ChatActions["addMessage"];
  updateSessionStatus: ChatActions["updateSessionStatus"];
  setSessionTitle: ChatActions["setSessionTitle"];
}

/**
 * The chat panel's send / stop / restart handlers. Built afresh on every
 * render of a panel with a session, exactly as the inline closures they were:
 * the panel hands them to its stable wrappers through refs.
 */
export function createChatPanelHandlers({
  tabId,
  session,
  grantHold,
  bindControlRef,
  setBindEpoch,
  addMessage,
  updateSessionStatus,
  setSessionTitle,
}: ChatPanelHandlerContext) {
  /** "Restart agent" on the stall notice: kill the plugin's (wedged) connect,
   *  forget the cached agent, re-arm the per-tab dedupes and bind again. The
   *  held first message stays held and dispatches when the new bind lands. */
  const handleRestartAgent = async () => {
    const pid = pluginIdForAgent(useChatStore.getState().sessions[tabId]?.agentType);
    setBindEpoch((n) => n + 1);
    logEvent({
      source: "atlas",
      kind: "agent-bind",
      summary: `${agentMeta(useChatStore.getState().sessions[tabId]?.agentType).label}: restart requested while starting`,
      payload: { tabId },
    });
    try {
      await agents.killPlugin(pid);
    } catch (e) {
      console.warn("killPlugin on restart failed:", e);
    }
    resetAgent(pid);
    bindControlRef.current?.retry();
  };
  /** "Switch agent" on the stall notice — the same path as ⌥/. With a first
   *  message held and no session yet, the switch happens in this tab and the
   *  message carries over (see `switchAgentForTab`). */
  const handleSwitchAgent = () => cycleChatAgent(tabId);
  /** "Copy diagnostics" on the stall notice: install state, npm log and
   *  Atlas log tails for this agent, as one text blob for a support report. */
  const handleCopyDiagnostics = async () => {
    const pid = pluginIdForAgent(useChatStore.getState().sessions[tabId]?.agentType);
    let text: string;
    try {
      text = await agents.startDiagnostics(pid);
    } catch (e) {
      toast.error(`Could not gather diagnostics: ${errInfo(e).message}`);
      return;
    }
    if (await copyText(text)) toast.success("Diagnostics copied");
    else toast.error("Could not copy diagnostics to the clipboard");
  };

  const handleStop = () => {
    const cs = useChatStore.getState();
    const s = cs.sessions[tabId];
    // Stop while the session is still starting: nothing has been dispatched,
    // so there is nothing to cancel on the wire — just let go of the held
    // message. The bubble stays, as it would for a cancelled turn.
    if (s?.pendingSend) {
      // ...but the CONNECT the message was waiting on may be wedged, and the
      // next send would otherwise re-enter "Starting" on the very same parked
      // backend future. Abandon this attempt, kill the plugin's connection and
      // forget the cached agent, so a following send starts a fresh connect.
      const pid = pluginIdForAgent(s.agentType);
      bindControlRef.current?.abandon();
      agents.killPlugin(pid).catch((e) => console.warn("killPlugin on Stop failed:", e));
      resetAgent(pid);
      cs.actions.setPendingSend(tabId, undefined);
      cs.actions.updateSessionStatus(tabId, "idle");
      return;
    }
    if (!s?.acpAgentId || !s.acpSessionId) return;

    // Pressing Stop again while a stop is already pending means the first one
    // did not appear to work, so escalate to killing the process. The backend
    // resolves a cancel the agent ignores after a grace period, which covers a
    // wedged *turn*; an agent that is wedged outright would hang the next turn
    // too, and this is the way out of that without quitting Atlas.
    //
    // Killing drops the connection, which takes its exit-watch task with it —
    // so no `agent_disconnected` arrives to clear the flags. We asked for this,
    // so we record it ourselves, which is also what raises the Restart banner.
    if (s.stopping) {
      cs.actions.noteAgentKilled(tabId);
      clearQueuedPrompts(tabId);
      cs.actions.clearPermissionsForSession(s.acpSessionId);
      agents.kill(s.acpAgentId).catch(() => {});
      return;
    }
    // Do NOT flip to idle optimistically: the backend may still be winding
    // tools down, and lying "idle" here let a new send race the still-live
    // turn (interleaved deltas; native history loss). Mark stop-requested
    // instead — the composer shows "Stopping…" and idle arrives with the
    // turn's real terminal (`turn_finished` stop_reason=cancelled), which
    // also clears the flag. Sends typed meanwhile queue exactly as they do
    // during a running turn; the backend actor also queues defensively.
    cs.actions.setStopping(tabId, true);
    // Rust's Stop discards the session's queue itself (and says so with
    // `queue_changed`); clearing the strip now saves the round trip, takes
    // any items still held locally with it, and withdraws any add still on
    // its way to Rust — which would otherwise land after the Stop and drain.
    clearQueuedPrompts(tabId);
    // Drop any permission modal that was awaiting the user's click.
    // The Rust side has already resolved the in-flight request as
    // `Cancelled` (see registry.cancel_turn); leaving the modal up
    // would let the user click Allow on a request the agent already
    // abandoned, which silently fails on the backend and confuses
    // them into thinking permission is broken.
    cs.actions.clearPermissionsForSession(s.acpSessionId);
    const key: SessionKey = {
      agent_id: s.acpAgentId,
      session_id: s.acpSessionId,
    };
    agents.cancel(key, { stop: true }).catch(() => {});
  };

  const handleSend = async (
    content: string,
    mentions: MentionData[],
    attachments?: ImageAttachment[],
    /** `recorded`: the user bubble, title and running status were already
     *  applied when this message was held as `pendingSend`; only dispatch.
     *  `clientMessageId`: that bubble's id, when the caller knows it. */
    opts?: { recorded?: boolean; clientMessageId?: string },
  ) => {
    const actualContent = content;
    noteSessionSent(projectPathForTab(tabId));

    // The mount effect kicks off the bind in parallel, but on a fresh
    // project the agent spawn + first new_session roundtrip can take a
    // few seconds. If the user hits Send before that lands, queue the
    // prompt and let the drain effect (`use-queue-drain.ts`) flush it once `acpSessionId`
    // appears. The MessageInput's queued-messages strip already shows the
    // pending text as a chip — same UX as "type while running".
    let bound = useChatStore.getState().sessions[tabId];
    // Dead agent process: respawn + resume first, then send (H4). Explicitly
    // user-initiated — this is the "next send lazily rebinds" path.
    if (bound?.disconnected) {
      const ok = await rebindDisconnectedSession(tabId);
      if (!ok) {
        addMessage(
          tabId,
          "assistant",
          "The agent could not be restarted. Check its runtime (Node/npx) and try again.",
        );
        return;
      }
      bound = useChatStore.getState().sessions[tabId];
    }
    // Fail closed on a mode a resume could not restore: queue, and the drain
    // effect sends it once the user has picked a mode. The composer already
    // refuses; this catches every other sender (chips, handoffs).
    if (bound?.unrestoredModeId) {
      enqueuePrompt(tabId, actualContent, mentions);
      return;
    }
    // Fail closed on a session another process is still writing (ADR-0001
    // amendment, Rule 7): sending would fork its transcript. This is the choke
    // point every sender passes — the composer (which already refuses), chips
    // and `atlas:chat-send` (another agent's `ui_chat` send, agent-switch
    // handoffs), the queue drain, the permission modal. Nothing is dropped:
    // the message queues (a held first message stays held, already recorded),
    // and the drain gate releases it on "Send anyway" or once the session
    // stops being live.
    if (isSendHeldElsewhere(bound?.acpSessionId)) {
      const cs = useChatStore.getState();
      if (opts?.recorded) {
        cs.actions.setPendingSend(tabId, {
          content: actualContent,
          mentions,
          attachments,
          clientMessageId: opts.clientMessageId,
        });
        // Not "Starting…": nothing is starting until the user says so.
        updateSessionStatus(tabId, "idle");
      } else {
        enqueuePrompt(tabId, actualContent, mentions);
      }
      return;
    }
    // The same for the no-AI-grant hold: the composer is locked, but a
    // next-step chip or a handoff is not the composer. Park it with the rest
    // of the held queue rather than send it to a gateway that will refuse it;
    // the hold's release drains it (`drain-gate.ts`). Not mid-turn — an answer
    // to the running turn's own question belongs to the turn already admitted,
    // and a message held for the bind (`recorded`) already has its bubble.
    if (grantHold && !opts?.recorded && !isBusyAgentStatus(bound?.status)) {
      enqueuePrompt(tabId, actualContent, mentions);
      return;
    }
    // `resumePending` is the resume-path equivalent of "not bound yet": the
    // transcript has painted from disk but the agent spawn + ACP `session/load`
    // haven't landed, so the optimistic `acpSessionId` points at a session the
    // manager hasn't installed. Queue rather than send into the void.
    if (!bound?.acpAgentId || !bound.acpSessionId || bound.resumePending) {
      const cs = useChatStore.getState();
      // The FIRST message into a session that is still starting is not
      // "typed during a turn" — nothing is running, the agent is just not up
      // yet (an in-tab agent switch respawns + `session/new` in 2–3 s). Show
      // it as sent, with the agent shown as starting, and hold the prompt on
      // the session; the drain effect dispatches it when the bind lands. A
      // QUEUED chip here read as "Atlas didn't send it". Anything typed
      // after it, or while a turn is live, still queues.
      const firstWhileStarting =
        !bound?.pendingSend &&
        (cs.queues[tabId]?.length ?? 0) === 0 &&
        !isBusyAgentStatus(bound?.status);
      if (firstWhileStarting) {
        const clientMessageId = addMessage(
          tabId,
          "user",
          actualContent,
          attachments,
          trustedMentionPaths(mentions),
        );
        logEvent({
          source: "chat",
          kind: "send-agent",
          summary: actualContent.slice(0, 120),
          payload: { tabId, mentionCount: mentions.length, heldForBind: true },
        });
        if (session.messages.length === 0) {
          setSessionTitle(
            tabId,
            actualContent.slice(0, 40) + (actualContent.length > 40 ? "..." : ""),
          );
        }
        updateSessionStatus(tabId, "running");
        cs.actions.setPendingSend(tabId, {
          content: actualContent,
          mentions,
          attachments,
          clientMessageId,
        });
        // A bind that was abandoned (Stop while starting) is not re-run by
        // anything but composer focus; make sure this send has one to wait on.
        bindControlRef.current?.kick();
        return;
      }
      enqueuePrompt(tabId, actualContent, mentions);
      return;
    }

    // The optimistic bubble's id rides with the prompt: Rust echoes it on the
    // prompt's `user_message` delta, and the reducer adopts this bubble rather
    // than drawing the prompt a second time. A held send's bubble was drawn
    // when it was held; the caller passes its id, or it is the newest one.
    let clientMessageId = opts?.clientMessageId;
    if (opts?.recorded && !clientMessageId) {
      const rows = useChatStore.getState().sessions[tabId]?.messages ?? [];
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].role === "user") {
          clientMessageId = rows[i].clientMessageId;
          break;
        }
      }
    }
    if (!opts?.recorded) {
      // The user-visible message keeps the prose as the user typed it,
      // including the shortform mention references (`@file:src/foo.rs` etc).
      // The context block goes only to the agent, not the local transcript.
      clientMessageId = addMessage(
        tabId,
        "user",
        actualContent,
        attachments,
        trustedMentionPaths(mentions),
      );
      logEvent({
        source: "chat",
        kind: "send-agent",
        summary: actualContent.slice(0, 120),
        payload: { tabId, mentionCount: mentions.length },
      });

      if (session.messages.length === 0) {
        setSessionTitle(
          tabId,
          actualContent.slice(0, 40) + (actualContent.length > 40 ? "..." : ""),
        );
      }
    }
    // Idempotent for a held send (already running while it started), and it
    // re-asserts the state if a fresh session's initial `idle` status landed
    // between the bind and this dispatch.
    updateSessionStatus(tabId, "running");

    // Expand mentions. Bodies that have no URI (notes, papers, past sessions)
    // still append under a fenced `## @ref` section; file/folder mentions come
    // back as structured `resourceLinks` and ride as ACP `ResourceLink` blocks
    // instead (P2.1) — see `mentions.ts::composePrompt`.
    let wirePrompt: string;
    let resourceLinks: { uri: string; name: string }[] = [];
    let pastedTexts: { id: string; text: string }[] = [];
    // A project or repo the message mentions is attached to the session
    // (read-only unless already granted more), and its mention tells the
    // agent the access it holds there.
    let composeMentions = mentions;
    if (mentions.some(isProjectMention)) {
      const attached = await attachMentionedProjects(bound.acpSessionId, mentions);
      composeMentions = attached.mentions;
      if (attached.projects) {
        useSessionProjectsStore.getState().actions.replace(bound.acpSessionId, attached.projects);
      }
      for (const r of attached.refused) {
        toast.warning(`${r.displayName} was not attached to this session`, {
          description: r.reason,
        });
      }
    }
    try {
      const composed = await composePrompt(actualContent, composeMentions);
      wirePrompt = composed.prose;
      resourceLinks = composed.resourceLinks;
      pastedTexts = composed.pastedTexts;
    } catch (err) {
      console.warn("composePrompt failed, sending raw text:", err);
      // A cite's passage is only in the context block `compose_prompt`
      // writes, so without one it is written out after the prose.
      wirePrompt = withReviewCommentsInline(withCitesInline(actualContent, mentions), mentions);
      // A paste is never only in the prose (just its `@paste:` token), so it
      // must survive a failed compose too.
      pastedTexts = mentions.flatMap((m) =>
        m.kind === "pasted_text" ? [{ id: m.id, text: m.text }] : [],
      );
    }

    // Ask the agent to end its reply with a hidden `<next_steps>` block — it has
    // the live session context, so the suggestions are better than a separate
    // model's. Appended to the WIRE prompt only (not the visible message); the
    // directive + the block are stripped from the thread. Gated on the setting.
    if (useSettingsStore.getState().settings.adaptiveSuggestions !== "off") {
      wirePrompt = appendNextStepsDirective(wirePrompt);
    }

    // Non-blocking send: returns the instant the prompt is queued onto the
    // SessionWorker. The atlas:agents `turn_finished` delta flips status
    // back to idle + handles empty-turn placeholder via `applyAgentDelta`.
    const key: SessionKey = {
      agent_id: bound.acpAgentId,
      session_id: bound.acpSessionId,
    };
    try {
      await agents.send(key, wirePrompt, attachments, resourceLinks, pastedTexts, clientMessageId);
      logEvent({
        source: "agent",
        kind: "stream-started",
        summary: `dispatched to ${bound.acpSessionId}`,
        payload: {
          tabId,
          acpSessionId: bound.acpSessionId,
          mentionCount: mentions.length,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useChatStore.getState().actions.addMessage(tabId, "assistant", `agent send error: ${msg}`);
      useChatStore.getState().actions.updateSessionStatus(tabId, "error");
      logEvent({
        source: "agent",
        kind: "stream-error",
        summary: msg.slice(0, 160),
        payload: { tabId },
      });
    }
  };

  /** A drain edge on a bound session: hand Rust whatever the window still
   *  holds and ask it to start the head (a no-op if it already did, or is
   *  busy, or held). A session whose agent process died is respawned first —
   *  the queue survives the restart in Rust, and the turn that left it there
   *  is what the old drain re-sent through a rebind. */
  const releaseQueue = async () => {
    const s = useChatStore.getState().sessions[tabId];
    if (!s?.acpSessionId) return;
    if (s.disconnected) {
      if ((useChatStore.getState().queues[tabId]?.length ?? 0) === 0) return;
      const before = s.acpSessionId;
      if (!(await rebindDisconnectedSession(tabId))) {
        addMessage(
          tabId,
          "assistant",
          "The agent could not be restarted. Check its runtime (Node/npx) and try again.",
        );
        return;
      }
      // Restarted onto a different session: the ids named the old one's queue.
      if (useChatStore.getState().sessions[tabId]?.acpSessionId !== before) {
        adoptQueueAsLocal(tabId);
      }
    }
    // While someone else holds the remote-control seat the owner's items wait
    // (R4: only the driver prompts). Rust's drain skips them too; not asking
    // keeps the window from racing a seat change. They run once the seat is
    // back — the next drain edge, or Rust's own when the seat returns.
    const sessionId = useChatStore.getState().sessions[tabId]?.acpSessionId;
    const remoteDriving = drivenElsewhere(useRcStore.getState().bySession[sessionId ?? ""]);
    await flushLocalQueue(tabId, { drain: remoteDriving === null });
  };

  return {
    handleRestartAgent,
    handleSwitchAgent,
    handleCopyDiagnostics,
    handleStop,
    handleSend,
    releaseQueue,
  };
}
