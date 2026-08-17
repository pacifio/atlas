import { toast } from "sonner";
import { emit } from "@tauri-apps/api/event";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { ensureAgent, getAgentSync } from "./agents-api";
import { errInfo } from "./agent-signin";
import {
  isBusyAgentStatus,
  pluginIdForAgent,
  type AgentType,
  type SwitchableAgent,
} from "@/types/agent";
import { invalidateLoad } from "./load-tokens";
import { resumeSessionFast } from "./resume-session";

/** Active project root, preferring the legacy `currentProject` but falling back
 *  to the active workspace path (mirrors the sidebar's `cwd` resolution). */
function activeCwd(): string {
  const project = useProjectStore.getState().currentProject;
  const ws = useWorkspaceStore.getState();
  return project?.path ?? ws.workspaces.find((w) => w.id === ws.activeWorkspaceId)?.path ?? "";
}

/** Nudge the history sidebar to refetch all three agent session lists. The
 *  sidebar listens for the Tauri `atlas:sessions-changed` event (gated on cwd),
 *  so re-emit it from the frontend after a local mutation (e.g. abandoning a
 *  chat via New Chat) — Codex/Cersei have no file watcher and Claude's is async,
 *  so the just-abandoned conversation would otherwise not re-list immediately. */
function refreshSessionLists(): void {
  const cwd = activeCwd();
  if (!cwd) return;
  void emit("atlas:sessions-changed", { cwd });
}

interface OpenOpts {
  /** ACP session id to open — the canonical per-session identity. If absent,
   *  just opens an empty chat. NOTE: do NOT key on a chat tab id; a tab (e.g.
   *  `welcome-chat`) hosts many sessions over its life, so focusing by tab id
   *  lands on whatever that tab currently shows, not the clicked session. */
  acpSessionId?: string;
  title: string;
  /** Project root for `loadSession`. */
  cwd: string;
  /** The agent that ran this session. Resuming through the wrong plugin makes
   *  `loadSession` fail and silently fall back to a blank session — the same
   *  bug the sidebar fixed. Defaults to Claude for legacy callers. */
  agentType?: AgentType;
}

function freshTabId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Open the agent chat focused on a specific ACP session, reloading its
 * transcript from disk. Assumes the target workspace is already active (the
 * caller switches workspaces first). Mirrors `session-sidebar.handleOpenAgent`'s
 * load flow (focus-if-open, reuse-idle-tab-else-new) so it can be invoked from
 * anywhere (e.g. the workspace switcher's Chats section).
 */
export async function openAgentSession({
  acpSessionId,
  title,
  cwd,
  agentType,
}: OpenOpts): Promise<void> {
  const chat = useChatStore.getState();
  const layout = useLayoutStore.getState();
  const { addTab, setActiveTab } = layout.actions;
  const {
    createSession,
    setAcpBinding,
    setSessionTitle,
    clearSession,
    setTranscriptLoading,
    setResumePending,
    replaceMessages,
    hydrateSessionSnapshot,
  } = chat.actions;

  // 1. Already open in a LIVE tab → focus it (covers re-clicks + running chats).
  //    Closing a chat tab leaves its chat-store session behind (orphan), so we
  //    must skip sessions whose tab no longer exists — otherwise `setActiveTab`
  //    can't find the dead tab and bounces to tab[0], "jumping" to an unrelated
  //    chat instead of loading the clicked session.
  if (acpSessionId) {
    const openTabIds = new Set(layout.tabs.map((t) => t.id));
    for (const [tid, s] of Object.entries(chat.sessions)) {
      if (s.acpSessionId === acpSessionId && openTabIds.has(tid)) {
        setActiveTab(tid);
        return;
      }
    }
  }

  // 2. Pick a target chat tab: reuse the active chat tab only if its session is
  //    idle (load in place — the "open in the agent chat tab" behaviour);
  //    otherwise open a FRESH tab so we never overwrite a running/other session.
  const activeId = layout.activeTabId;
  const activeTab = activeId ? layout.tabs.find((t) => t.id === activeId) : undefined;
  const activeSession = activeId ? chat.sessions[activeId] : undefined;
  const reuse = activeTab?.type === "chat" && (!activeSession || activeSession.status === "idle");
  const targetTabId = reuse && activeId ? activeId : freshTabId();

  if (targetTabId !== activeId) {
    addTab({
      id: targetTabId,
      type: "chat",
      title: title.slice(0, 40) || "Chat",
      closable: true,
      dirty: false,
      data: {},
    });
    createSession(targetTabId);
  }
  setActiveTab(targetTabId);

  // No session to restore (a never-messaged chat) → leave the empty tab.
  if (!acpSessionId) return;

  // If we're reusing the current tab in place and it held a real (messaged)
  // chat, that chat loses its live sidebar row on clear — refresh the disk
  // lists so it re-lists from history immediately (Cersei/Codex have no watcher).
  const abandoningCurrent =
    reuse &&
    targetTabId === activeId &&
    !!activeSession &&
    ((activeSession.userMessageCount ?? 0) > 0 || activeSession.messages.length > 0);

  // Optimistic bind + spinner, then hydrate from the (cached) Rust session.
  clearSession(targetTabId);
  if (abandoningCurrent) refreshSessionLists();
  setSessionTitle(targetTabId, title.slice(0, 40));
  // Resume through the session's OWN agent — loading a Codex/OpenCode session
  // through the Claude plugin fails and falls back to a blank chat.
  const pluginId = pluginIdForAgent(agentType);
  if (agentType && agentType !== "custom") {
    useChatStore.getState().actions.setSessionAgentType(targetTabId, agentType);
  }
  const cached = getAgentSync(pluginId);
  if (cached) setAcpBinding(targetTabId, cached.agent_id, acpSessionId, cwd);
  // The binding above is optimistic — gate sends until the backend really has
  // the session (see `ChatSession.resumePending`).
  setResumePending(targetTabId, true);
  setTranscriptLoading(targetTabId, true);
  try {
    // Two-stage: paint from disk in ~50ms, bind the agent concurrently. See
    // `resumeSessionFast` for why the old single-await chain felt slow.
    const { agent, snapshot } = await resumeSessionFast({
      pluginId,
      sessionId: acpSessionId,
      cwd,
      ensure: () => ensureAgent(pluginId),
      cb: {
        paint: (msgs) => replaceMessages(targetTabId, msgs),
        onPainted: () => setTranscriptLoading(targetTabId, false),
        isStale: () => false,
      },
    });
    setAcpBinding(targetTabId, agent.agent_id, acpSessionId, cwd);
    // Restore live status + docked plan AFTER the bind (which clears the plan).
    hydrateSessionSnapshot(targetTabId, snapshot.status, snapshot.plan);
    setTranscriptLoading(targetTabId, false);
    setResumePending(targetTabId, false);
  } catch (err) {
    setTranscriptLoading(targetTabId, false);
    setResumePending(targetTabId, false);
    // `errInfo`: the spawn/load commands in this path reject with a structured
    // `{message, kind}` that would render as "[object Object]".
    toast.error(`Couldn't open session: ${errInfo(err).message}`);
  }
}

/**
 * Open / focus the SINGLE agent chat tab and start a fresh chat in it.
 *
 * The agent chat is a singleton tab — "New chat" never spawns a second tab
 * (the user switches between past chats via the session-history sidebar). If a
 * chat tab is already open we focus it and reset its session in place (a brand
 * new session in the SAME tab); the previous conversation, if any, is already
 * persisted to disk per-turn, so it stays reachable from the history sidebar.
 * The fresh session is NOT added to history until the user actually submits
 * (the sidebar filters on `userMessageCount > 0`).
 *
 * If the current chat is BUSY (running, or waiting on a permission), it is left
 * completely alone — Atlas's whole point is many agents working concurrently, so
 * "new chat" must never stop or orphan a live turn. We open a fresh tab beside
 * it instead (multiple chat tabs already coexist — `openAgentSession` spawns one
 * whenever the active chat is running). Only an IDLE chat is reset in place.
 *
 * `agent` binds the fresh session to a specific agent — the busy branch of the
 * ⌥/ cycle and the composer's agent switcher route here so switching agents
 * mid-turn spawns a new chat instead of killing the live one.
 */
export function openNewAgentChat(agent?: SwitchableAgent): void {
  const layout = useLayoutStore.getState();
  const chat = useChatStore.getState();
  const { addTab, setActiveTab } = layout.actions;
  const { clearSession, createSession, switchChatAgent } = chat.actions;

  const focus = (id: string) =>
    window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId: id } }));

  // Prefer the ACTIVE chat tab; fall back to the first chat tab. Multiple chat
  // tabs can coexist (handleOpenAgent spawns a new one when the current chat is
  // running), so `tabs.find(type==="chat")` alone could reset a tab the user
  // isn't even looking at.
  const activeChatTab = layout.activeTabId
    ? layout.tabs.find((t) => t.id === layout.activeTabId && t.type === "chat")
    : undefined;
  const existing = activeChatTab ?? layout.tabs.find((t) => t.type === "chat");
  if (existing && !isBusyAgentStatus(chat.sessions[existing.id]?.status)) {
    setActiveTab(existing.id);
    // Cancel any in-flight history load targeting this tab BEFORE clearing, so a
    // resolving `loadSession → replaceMessages` chain can't repaint the freshly
    // cleared blank session with the old transcript.
    invalidateLoad(existing.id);
    clearSession(existing.id);
    if (agent) switchChatAgent(existing.id, agent);
    focus(existing.id);
    // The abandoned conversation persists to disk per-turn, but its live row was
    // the sidebar's only handle on it until a disk refetch. Re-list now so it
    // stays in history instead of vanishing.
    refreshSessionLists();
    return;
  }

  // No chat tab open, or the current chat is mid-turn → fresh tab.
  const id = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  addTab({ id, type: "chat", title: "Agents", closable: true, dirty: false, data: {} });
  createSession(id);
  if (agent) switchChatAgent(id, agent);
  setActiveTab(id);
  focus(id);
}
