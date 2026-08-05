import { lazy, Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../stores/chat-store";
import { useDetailPanelStore } from "../stores/detail-panel-store";
import { appendNextStepsDirective } from "../lib/next-steps";
import { stripInjectedContext } from "../lib/atlas-context";
import { agents, ensureAgent, CODEX_PLUGIN_ID, codexStatus } from "../lib/agents-api";
import { loadCachedAcpModes } from "../lib/acp-modes-cache";
import { warmAcpModels, otherAcpAgents } from "../lib/warm-acp-models";
import type { ImageAttachment, SessionKey } from "@/types/agents";
import type { ChatMessage } from "@/types/agent";
import {
  hasInFlightToolCalls,
  isBusyAgentStatus,
  agentTypeFromPluginId,
  pluginIdForAgent,
} from "@/types/agent";
import {
  composePrompt,
  type MentionData,
  type MentionSkill,
} from "../lib/mentions";
import { sharedMemory } from "@/features/memory/lib/shared-memory-api";
import { usePaneFind } from "../lib/use-pane-find";
import { MessageInput } from "./message-input";
import { SessionSidebar } from "./session-sidebar";
import { ChatHeader } from "./chat-header";
import { openNewAgentChat } from "../lib/open-agent-session";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchTextDiff } from "@/features/git/lib/git-diff-api";
import { getEditParts, getFilePathFromInput } from "../lib/tool-files";
import {
  OPEN_TURN_DIFF_EVENT,
  toRepoRelative,
  type TurnDiffRequest,
} from "../lib/open-turn-diff";

/** Height the floating header occupies — the transcript pads its content by
 *  this much so the first row clears the bar. Must match `ChatHeader`'s bar. */
const HEADER_INSET = 46;
import { PermissionModal } from "./permission-modal";
import { ClaudeSetupBanner } from "@/features/claude-setup/components/claude-setup-banner";
import { NodeSetupBanner } from "@/features/node-setup/components/node-setup-banner";
import { useNodeSetupStore } from "@/features/node-setup/stores/node-setup-store";
import { ClaudeLoginDialog } from "@/features/claude-setup/components/claude-login-dialog";
import { useClaudeSetupStore } from "@/features/claude-setup/stores/claude-setup-store";

// Both panels are modal-style and never visible on first paint. Lazy so
// they don't add to the initial chunk.
const BashHistoryPanel = lazy(() =>
  import("./bash-history-panel").then((m) => ({ default: m.BashHistoryPanel })),
);
const PlansPanel = lazy(() =>
  import("./plans-panel").then((m) => ({ default: m.PlansPanel })),
);
const ChatSearchPalette = lazy(() =>
  import("./chat-search-palette").then((m) => ({
    default: m.ChatSearchPalette,
  })),
);

// The transcript transitively imports the markdown vendor chunk
// (`remark-gfm` + `rehype-highlight`, ~330 KB raw / 101 KB gzip). Lazy so an
// empty-chat first paint doesn't preload it; loads the first time this tab has
// messages.
const Transcript = lazy(() =>
  import("./transcript").then((m) => ({ default: m.Transcript })),
);
import type { TranscriptHandle } from "./transcript";
// Diffs + tool output live here rather than inline in the thread — see the
// module header for why that's a perf decision as much as a UX one.
const DetailPanel = lazy(() =>
  import("./detail-panel").then((m) => ({ default: m.DetailPanel })),
);
// Full-screen side-by-side diff for a turn's changes. Lazy: it pulls the
// virtualizer + the diff-highlight worker, and most sessions never open it.
const GitDiffModal = lazy(() =>
  import("@/features/git/components/git-diff-modal").then((m) => ({
    default: m.GitDiffModal,
  })),
);
import {
  Sparkles,
  Search,
  Loader2,
  ChevronDown,
  ArrowRight,
  LogIn,
  GitCompare,
  FlaskConical,
} from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";
import { copyText } from "@/lib/clipboard";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { logEvent } from "@/features/log/lib/log";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import { loadCachedAcpModels } from "../lib/acp-models-cache";

interface ChatPanelProps {
  tabId: string;
}

// Once-per-app-session guard for the background Codex pre-warm (below).
let acpPrewarmStarted = false;

/** Rebind a session whose agent process died: respawn the plugin (its spawn
 *  cache was reset on disconnect) and RESUME the same session id where the
 *  transcript kind supports it (Claude JSONL, Codex engine-side) — falling
 *  back to a fresh session if the resume fails. Never runs unprompted: only
 *  the next Send or the explicit Restart affordance calls this (no silent
 *  auto-restart loops). */
async function rebindDisconnectedSession(tabId: string): Promise<boolean> {
  const cs = useChatStore.getState();
  const sess = cs.sessions[tabId];
  if (!sess) return false;
  const pluginId = pluginIdForAgent(sess.agentType);
  try {
    const agent = await ensureAgent(pluginId);
    const cwd =
      sess.workingDirectory ||
      useProjectStore.getState().currentProject?.path ||
      "/";
    let key: SessionKey;
    if (sess.acpSessionId) {
      try {
        key = await agents.loadSession(agent.agent_id, sess.acpSessionId, cwd);
      } catch (err) {
        console.warn("resume after disconnect failed; starting fresh:", err);
        key = await agents.newSession(agent.agent_id, cwd);
      }
    } else {
      key = await agents.newSession(agent.agent_id, cwd);
    }
    const actions = useChatStore.getState().actions;
    actions.setAcpBinding(tabId, agent.agent_id, key.session_id, cwd);
    actions.setDisconnected(tabId, false);
    return true;
  } catch (err) {
    console.warn("agent restart failed:", err);
    return false;
  }
}

/**
 * The before/after text a single turn produced, per file.
 *
 * Walks the turn's assistant run — `turnId` is `t:<first assistant message id>`,
 * the same formula the row projection uses — and folds every edit tool call into
 * one before/after pair per path. Multiple edits to the same file concatenate in
 * order, so a turn that touched a file three times reads as one diff rather than
 * three competing ones.
 *
 * A `Write` carries whole content (`old` empty), which is why a file CREATED by
 * the turn renders in full. An `Edit` carries only the replaced fragment, so its
 * diff covers that fragment — honest about what the record holds. A file the
 * turn only deleted contributes no edit parts and simply does not appear, which
 * is the correct answer: there is nothing to browse.
 */
function collectTurnEdits(
  messages: ChatMessage[],
  turnId: string,
  repoPath: string,
  preferredFile?: string,
): {
  files: string[];
  initial: string;
  sources: Record<string, { old: string; new: string }>;
} {
  const firstId = turnId.startsWith("t:") ? turnId.slice(2) : turnId;
  const start = messages.findIndex((m) => m.id === firstId);
  const sources: Record<string, { old: string; new: string }> = {};
  const order: string[] = [];

  if (start >= 0) {
    // The turn is the consecutive assistant run beginning at that message.
    for (let i = start; i < messages.length && messages[i].role === "assistant"; i++) {
      for (const tc of messages[i].toolCalls) {
        const args = tc.arguments ?? {};
        const parts = getEditParts(tc.toolName, args);
        if (parts.length === 0) continue;
        const abs = getFilePathFromInput(args);
        if (!abs) continue;
        const path = toRepoRelative(abs, repoPath);
        if (!sources[path]) {
          sources[path] = { old: "", new: "" };
          order.push(path);
        }
        for (const p of parts) {
          sources[path].old += p.old;
          sources[path].new += p.neu;
        }
      }
    }
  }

  const wanted = preferredFile ? toRepoRelative(preferredFile, repoPath) : "";
  return {
    files: order,
    initial: wanted && sources[wanted] ? wanted : (order[0] ?? ""),
    sources,
  };
}

export function ChatPanel({ tabId }: ChatPanelProps) {
  // Subscribe to ONLY this tab's session. Streaming chunks on other tabs
  // shouldn't repaint this panel — immer preserves reference equality for
  // unchanged sub-paths, so `s.sessions[tabId]` only changes when this tab
  // mutates.
  const session = useChatStore((s) => s.sessions[tabId]);
  const { createSession, addMessage, updateSessionStatus, setSessionTitle } =
    useChatStore.use.actions();
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "assistant">(
    "all",
  );
  const [bashPanelOpen, setBashPanelOpen] = useState(false);
  const [plansPanelOpen, setPlansPanelOpen] = useState(false);
  // Narrow boolean — changes only when the detail panel opens or closes.
  const detailOpen = useDetailPanelStore((s) => !!s.targets[tabId]);

  // Full-screen diff. Driven by a window event rather than a prop chain so a row
  // opening it re-renders nothing in the transcript.
  const [turnDiff, setTurnDiff] = useState<{
    files: string[];
    initial: string;
    sources: Record<string, { old: string; new: string }>;
  } | null>(null);

  const queryClient = useQueryClient();
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<TurnDiffRequest>).detail;
      if (!detail?.turnId) return;
      const repo = useProjectStore.getState().currentProject?.path ?? "";
      const messages = useChatStore.getState().sessions[tabId]?.messages ?? [];
      const next = collectTurnEdits(messages, detail.turnId, repo, detail.file);
      // Start the diff BEFORE the modal exists. The viewer would otherwise wait
      // for its own mount to fire the same request, putting an IPC round trip
      // after the open animation rather than underneath it.
      const src = next.sources[next.initial];
      if (src) prefetchTextDiff(queryClient, repo, next.initial, src);
      setTurnDiff(next);
    };
    window.addEventListener(OPEN_TURN_DIFF_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TURN_DIFF_EVENT, onOpen);
  }, [tabId, queryClient]);

  // Warm everything the diff modal needs while the reader is idle, so opening
  // it is a paint rather than a fetch: the chunk itself (which now pulls the
  // panel with it), and the syntax-highlight worker — WebKit suspends idle
  // workers, and a cold one costs a round trip on the first highlighted file.
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
    };
    const load = () => {
      void import("@/features/git/components/git-diff-modal");
      void import("@/features/git/lib/diff-highlight-cache").then((m) =>
        m.warmDiffHighlightWorker?.(),
      );
    };
    // Short timeout: this competes with nothing the reader can see, and waiting
    // four seconds meant an early click still paid full price.
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(load, { timeout: 1200 });
    } else {
      const t = window.setTimeout(load, 800);
      return () => window.clearTimeout(t);
    }
  }, []);
  // Cmd+F find — scoped to this pane + tab (see usePaneFind).
  const [searchPaletteOpen, setSearchPaletteOpen] = usePaneFind(tabId);
  const rootRef = useRef<HTMLDivElement>(null);

  // Scroll-to-bottom state is owned here so the floating button can live
  // next to the Claude-setup pill above the input (instead of inside
  // the transcript). Transcript publishes the "scrolled up" bit via
  // `onShowJumpChange` and exposes `scrollToBottom` via its ref.
  const messagesListRef = useRef<TranscriptHandle>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [jumpCount, setJumpCount] = useState(0);
  // Stable so the transcript's `[showJump, newCount, onShowJumpChange]`
  // effect doesn't re-fire on every ChatPanel render (i.e. every stream chunk).
  const onShowJumpChange = useCallback((visible: boolean, count?: number) => {
    setShowJumpToBottom(visible);
    setJumpCount(count ?? 0);
  }, []);

  // The role filter is applied here rather than inside the transcript: the
  // projection turns a message list into turns and rows, so handing it a
  // pre-filtered list keeps that pass single-purpose. Identity is preserved in
  // the (overwhelmingly common) "all" case so the projection memo isn't
  // invalidated on every render.
  // Header label. Prefer the session's own title; fall back to the first user
  // message (what the history list shows) so a chat that hasn't been titled yet
  // still reads as itself rather than "New Chat".
  const headerTitle = useMemo(() => {
    const t = stripInjectedContext(session?.title ?? "").trim();
    if (t && t !== "New Chat") return t;
    const first = stripInjectedContext(session?.firstUserContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return first.slice(0, 60) || "New chat";
  }, [session?.title, session?.firstUserContent]);

  const filteredMessages = useMemo(
    () =>
      roleFilter === "all"
        ? session?.messages ?? []
        : (session?.messages ?? []).filter((m) => m.role === roleFilter),
    [session?.messages, roleFilter],
  );

  const acpSessionId = session?.acpSessionId ?? "";

  useEffect(() => {
    if (!session) {
      createSession(tabId);
    }
  }, [tabId, session, createSession]);

  // Bind an ACP agent + session to this tab as soon as the panel mounts.
  // The agent spawn takes 1–3 s warm and up to 30 s on a cold `npx` cache,
  // so kicking it off in parallel with the user reading the empty chat
  // hides the latency. If the user hits Send before the bind lands, the
  // submit handler queues the message and the drain effect below flushes
  // it once `acpSessionId` is set. Skipped when a session is already bound
  // (sidebar resume, or a tab re-mount).
  useEffect(() => {
    if (!session) return;
    if (session.acpSessionId) return;
    let cancelled = false;
    let pending = false;
    const ensureBound = async () => {
      if (cancelled || pending) return;
      pending = true;
      try {
        // Bind to THIS session's chosen agent (Claude by default, or Codex),
        // not a single global default — so per-tab agents run in parallel.
        const at = useChatStore.getState().sessions[tabId]?.agentType;
        const pluginId = pluginIdForAgent(at);
        const agent = await ensureAgent(pluginId);
        if (cancelled) return;
        const project = useProjectStore.getState().currentProject;
        const cwd = project?.path ?? "/";
        const key = await agents.newSession(agent.agent_id, cwd);
        if (cancelled) return;
        // Guard against an agent switch that landed mid-bind: if the tab's
        // agentType changed since we picked `pluginId`, this binding is for the
        // wrong agent — abandon it so we don't clobber the tab with a stale
        // (e.g. Codex) session under the newly-chosen agent. The deps now watch
        // agentType, so the effect re-runs and binds the right agent.
        const nowAt = useChatStore.getState().sessions[tabId]?.agentType;
        if (pluginIdForAgent(nowAt) !== pluginId) return;
        // Apply the tab's permission mode BEFORE exposing the binding.
        // `setAcpBinding` is what flushes any queued send, so if we set the
        // mode after it the first turn can race ahead of (e.g.)
        // bypassPermissions and still trigger a stray prompt on turn one.
        // Awaiting here guarantees the agent is in the right mode first.
        const mode =
          useChatStore.getState().sessions[tabId]?.claudePermissionMode ??
          "default";
        if (mode !== "default") {
          try {
            await agents.setMode(key, mode);
          } catch (err) {
            console.warn("setMode at session create failed:", err);
          }
          if (cancelled) return;
        }
        useChatStore
          .getState()
          .actions.setAcpBinding(tabId, agent.agent_id, key.session_id, cwd);
        // Seed the composer mode picker from the freshly-created session's
        // advertised modes (Codex: read-only / auto / full-access). The modes
        // are seeded into the Rust SessionState by `new_session`, so the
        // snapshot here already carries them. Claude ignores these in favour
        // of its own permission pill.
        try {
          const snap = await agents.snapshot(key);
          if (!cancelled) {
            // Defensive `?.` — a snapshot from an older agent build may omit
            // these arrays; a throw here used to silently skip ALL seeding.
            const modes = snap.available_modes ?? [];
            const models = snap.available_models ?? [];
            console.debug("[acp-models] snapshot", {
              agent: useChatStore.getState().sessions[tabId]?.agentType,
              models: models.length,
              current: snap.current_model,
              modes: modes.length,
            });
            // Only seed when the agent actually advertised modes, so we never
            // clobber the optimistic cached modes with an empty set.
            if (modes.length > 0) {
              useChatStore
                .getState()
                .actions.setAcpModes(
                  tabId,
                  snap.current_mode,
                  modes,
                  agentTypeFromPluginId(snap.plugin_id)
                );
            }
            // Seed the ACP model picker (Claude Code / Codex) from the snapshot's
            // advertised models. Empty when the agent exposes no model selection.
            if (models.length > 0) {
              useChatStore
                .getState()
                .actions.setAcpModels(tabId, snap.current_model, models);
            }
            // Boot finished (with or without modes) — drop the loading state.
            useChatStore.getState().actions.setAcpModesPending(tabId, false);
          }
        } catch (err) {
          console.warn("snapshot for modes failed:", err);
          if (!cancelled) useChatStore.getState().actions.setAcpModesPending(tabId, false);
        }
      } catch (err) {
        console.warn("Agent session creation failed:", err);
        // Bind failed (agent not installed / spawn error) — clear the spinner so
        // the picker doesn't hang in a loading state forever.
        if (!cancelled) useChatStore.getState().actions.setAcpModesPending(tabId, false);
      } finally {
        pending = false;
      }
    };
    // Eager bind on mount.
    void ensureBound();
    // Focus event acts as a retry — if the initial bind threw (e.g. the
    // agent process couldn't spawn yet because Claude Code finished
    // installing mid-session), refocusing the composer will try again.
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId?: string }>).detail;
      if (!detail || detail.tabId !== tabId) return;
      if (useChatStore.getState().sessions[tabId]?.acpSessionId) return;
      void ensureBound();
    };
    window.addEventListener("atlas:chat-input-focused", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("atlas:chat-input-focused", handler);
    };
    // `!!session` is in the dep list so the bind effect actually
    // fires after the parallel `createSession` effect above flips
    // `session` from null → defined. Without it, deps stay
    // `[tabId, undefined]` across both renders (acpSessionId is
    // still undefined on the newly-created session) so React skips
    // the effect, the bind never starts, and every send sits in
    // the queue forever — the exact "messages get queued on a
    // brand-new project" symptom.
    // `agentType` is in the deps so switching the tab's agent (⌥/) re-runs the
    // bind — its cleanup cancels any in-flight bind for the previous agent (the
    // `cancelled` guard), preventing a stale bind from clobbering the tab. This
    // matters even when acpSessionId was already undefined (switch during the
    // first bind), where acpSessionId alone wouldn't change.
  }, [tabId, !!session, session?.acpSessionId, session?.agentType]);

  // Backfill the ACP model picker for ALREADY-bound sessions. The bind effect
  // above returns early once `acpSessionId` is set, so a session that was bound
  // before the model list existed (app update / HMR / resumed session) would
  // never get its models. When we have a binding for a non-native agent but no
  // models yet, fetch the snapshot once and seed them.
  useEffect(() => {
    const agentId = session?.acpAgentId;
    const acpSessionId = session?.acpSessionId;
    if (!agentId || !acpSessionId) return;
    if (session?.agentType === "cersei") return;
    if ((session?.acpAvailableModels?.length ?? 0) > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await agents.snapshot({ agent_id: agentId, session_id: acpSessionId });
        if (cancelled) return;
        const models = snap.available_models ?? [];
        console.debug("[acp-models] backfill", {
          agent: session?.agentType,
          models: models.length,
        });
        if (models.length > 0) {
          useChatStore.getState().actions.setAcpModels(tabId, snap.current_model, models);
        } else {
          // ACP `session/load` doesn't re-advertise models, so resumed
          // sessions get an empty snapshot. Fall back to the per-agent cache —
          // same agent, so no cross-agent leak — which also seeds
          // `acpCurrentModel` (when unset) so new assistant messages get a
          // model stamp/badge again in resumed sessions.
          // Re-read the agent type from the store — the closed-over `session`
          // is the render-time value and can be stale after the await.
          const at =
            useChatStore.getState().sessions[tabId]?.agentType ?? "claude-code";
          const cached = loadCachedAcpModels(at);
          if (cached && cached.availableModels.length > 0) {
            useChatStore
              .getState()
              .actions.setAcpModels(tabId, cached.currentModel, cached.availableModels);
          }
        }
      } catch {
        // best-effort backfill
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    tabId,
    session?.acpAgentId,
    session?.acpSessionId,
    session?.agentType,
    session?.acpAvailableModels?.length,
  ]);

  // While a chat is active on one ACP agent, prefetch the other used agents'
  // model lists in the background so switching is instant (cached). Fire-and-
  // forget, once per app session per agent.
  useEffect(() => {
    const at = session?.agentType;
    if (!at) return;
    const others = otherAcpAgents(at);
    if (others.length === 0) return;
    const cwd = useProjectStore.getState().currentProject?.path ?? "/";
    for (const other of others) void warmAcpModels(other, cwd);
  }, [session?.agentType]);

  // Shift+Tab → cycle the agent permission mode. Registered on the window in
  // capture phase so the browser's default focus traversal never steals it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const root = rootRef.current;
      const active = document.activeElement as HTMLElement | null;
      // Only intercept when focus is somewhere inside this chat panel.
      if (!root || !active || !root.contains(active)) return;
      e.preventDefault();
      e.stopPropagation();
      // The store action both cycles the mode AND propagates it to the bound
      // agent (so e.g. bypassPermissions actually stops permission prompts).
      // For non-Claude agents (Codex) cycle the agent-advertised ACP modes.
      const sess = useChatStore.getState().sessions[tabId];
      const actions = useChatStore.getState().actions;
      if (sess?.agentType !== "claude-code") {
        const modes = sess?.acpAvailableModes ?? [];
        if (modes.length === 0) return;
        const i = modes.findIndex((m) => m.id === sess?.acpCurrentMode);
        const next = modes[(i + 1) % modes.length];
        actions.setAcpMode(tabId, next.id);
        return;
      }
      actions.cycleClaudePermissionMode(tabId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [tabId]);
  // NOTE: seeding the composer's ACP mode picker for resumed/restored sessions
  // is handled consumer-side in MessageInput (self-heal), so it can't be missed
  // by an effect that didn't re-run. The create-effect above still seeds the
  // fast path for freshly-created sessions.

  // Pre-warm secondary ACP agents in the background. The ~3-4s a fresh switch
  // pays is dominated by spawning the adapter (npx / CLI) + the ACP initialize
  // handshake; `ensureAgent` does exactly that (deduped/cached, no session, no
  // auth), so paying it ahead of time makes the actual switch fast. Gated per
  // agent on the user having used it before (a persisted modes cache exists) so
  // we never spawn agents someone only ever ignores. Runs once per app session,
  // deferred and staggered so it never competes with the primary (Claude) bind.
  useEffect(() => {
    if (acpPrewarmStarted) return;
    acpPrewarmStarted = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    (["codex", "opencode"] as const).forEach((at, i) => {
      if (!loadCachedAcpModes(at)) return; // never used → skip
      timers.push(
        setTimeout(
          () => {
            void ensureAgent(pluginIdForAgent(at)).catch(() => {
              // Not installed / not ready — the real switch surfaces a proper
              // error; allow a later retry by clearing the once-flag.
              acpPrewarmStarted = false;
            });
          },
          1500 + i * 1000,
        ),
      );
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  // Drain the per-tab queue when the agent transitions back to idle OR
  // when the ACP session id first becomes available. The latter covers the
  // "user typed and hit Send before the bind landed" case — submit pushes
  // onto the queue and this effect flushes it the moment the binding
  // appears, no error message, no lost message.
  const prevStatusRef = useRef<string | null>(null);
  const prevAcpRef = useRef<string | undefined>(undefined);
  const prevResumingRef = useRef(false);
  const handleSendRef = useRef<
    ((content: string, mentions: MentionData[]) => void) | null
  >(null);
  const handleStopRef = useRef<(() => void) | null>(null);
  // STABLE wrappers passed to the memoized <ChatComposer> so it doesn't
  // re-render on every ChatPanel render (i.e. every streaming chunk). The real
  // handlers are reassigned to the refs each render, so the wrappers always call
  // the latest logic while keeping a constant identity. This is the H1 fix:
  // ChatPanel still re-renders per chunk, but its heavy composer subtree bails.
  const onSendStable = useCallback(
    (content: string, mentions: MentionData[]) => handleSendRef.current?.(content, mentions),
    [],
  );
  const onStopStable = useCallback(() => handleStopRef.current?.(), []);
  const onScrollToBottomStable = useCallback(
    () => messagesListRef.current?.scrollToBottom(),
    [],
  );
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
    const curResuming = !!session?.resumePending;
    const prevResuming = prevResumingRef.current;
    prevResumingRef.current = curResuming;
    const turnFinished = prev === "running" && cur !== "running";
    const justBound = !prevAcp && !!curAcp;
    const justResumed = prevResuming && !curResuming && !!curAcp;
    if (turnFinished || justBound || justResumed) {
      const next = useChatStore.getState().actions.shiftQueue(tabId);
      if (next && handleSendRef.current) {
        // Defer one microtask so the React commit completes first.
        // Queued messages don't carry their original mentions yet — empty
        // array here is intentional (see MessageInput.submit).
        Promise.resolve().then(() => handleSendRef.current?.(next, []));
      }
    }
    // Next-step chips are extracted from the agent's own `<next_steps>` block in
    // the chat-store `turn_finished` reducer — nothing to do here.
  }, [session?.status, session?.acpSessionId, session?.resumePending, tabId]);

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

  if (!session) return null;

  const handleStop = () => {
    const cs = useChatStore.getState();
    const s = cs.sessions[tabId];
    if (!s?.acpAgentId || !s.acpSessionId) return;
    // Do NOT flip to idle optimistically: the backend may still be winding
    // tools down, and lying "idle" here let a new send race the still-live
    // turn (interleaved deltas; native history loss). Mark stop-requested
    // instead — the composer shows "Stopping…" and idle arrives with the
    // turn's real terminal (`turn_finished` stop_reason=cancelled), which
    // also clears the flag. Sends typed meanwhile queue exactly as they do
    // during a running turn; the backend actor also queues defensively.
    cs.actions.setStopping(tabId, true);
    cs.actions.clearQueue(tabId);
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
    agents.cancel(key).catch(() => {});
  };

  const handleSend = async (
    content: string,
    mentions: MentionData[],
    attachments?: ImageAttachment[],
  ) => {
    const actualContent = content;

    // The mount effect kicks off the bind in parallel, but on a fresh
    // project the agent spawn + first new_session roundtrip can take a
    // few seconds. If the user hits Send before that lands, queue the
    // prompt and let the drain effect above flush it once `acpSessionId`
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
    // `resumePending` is the resume-path equivalent of "not bound yet": the
    // transcript has painted from disk but the agent spawn + ACP `session/load`
    // haven't landed, so the optimistic `acpSessionId` points at a session the
    // manager hasn't installed. Queue rather than send into the void.
    if (!bound?.acpAgentId || !bound.acpSessionId || bound.resumePending) {
      useChatStore.getState().actions.enqueueMessage(tabId, actualContent);
      return;
    }

    // The user-visible message keeps the prose as the user typed it,
    // including the shortform mention references (`@file:src/foo.rs` etc).
    // The context block goes only to the agent, not the local transcript.
    addMessage(tabId, "user", actualContent, attachments);
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

    updateSessionStatus(tabId, "running");

    // Expand mentions into a trailing context block. composePrompt fetches
    // file/note/paper bodies via Tauri and appends them under a fenced
    // `## @ref` section — see `mentions.ts::composePrompt`.
    let wirePrompt: string;
    try {
      wirePrompt = await composePrompt(actualContent, mentions);
    } catch (err) {
      console.warn("composePrompt failed, sending raw text:", err);
      wirePrompt = actualContent;
    }

    // Ask the agent to end its reply with a hidden `<next_steps>` block — it has
    // the live session context, so the suggestions are better than a separate
    // model's. Appended to the WIRE prompt only (not the visible message); the
    // directive + the block are stripped from the thread. Gated on the setting.
    if (useProjectStore.getState().settings.adaptiveSuggestions !== "off") {
      wirePrompt = appendNextStepsDirective(wirePrompt);
    }

    // Best-effort, invisible: record that this turn applied one or more skills
    // so cross-agent shared memory reflects it (no view projection — see
    // EventKind::SkillUsed). Fire-and-forget; must never block or break send.
    const usedSkills = mentions.filter(
      (m): m is MentionSkill => m.kind === "skill",
    );
    const memoryProject =
      useProjectStore.getState().currentProject?.path ?? null;
    if (usedSkills.length > 0 && memoryProject) {
      void sharedMemory
        .appendEvent(
          memoryProject,
          bound.acpAgentId,
          bound.acpSessionId,
          "skill_used",
          null,
          { skills: usedSkills.map((m) => m.skillName) },
        )
        .catch(() => {});
    }

    // Non-blocking send: returns the instant the prompt is queued onto the
    // SessionWorker. The atlas:agents `turn_finished` delta flips status
    // back to idle + handles empty-turn placeholder via `applyAgentDelta`.
    const key: SessionKey = {
      agent_id: bound.acpAgentId,
      session_id: bound.acpSessionId,
    };
    try {
      await agents.send(key, wirePrompt, attachments);
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
      useChatStore
        .getState()
        .actions.addMessage(tabId, "assistant", `agent send error: ${msg}`);
      useChatStore.getState().actions.updateSessionStatus(tabId, "error");
      logEvent({
        source: "agent",
        kind: "stream-error",
        summary: msg.slice(0, 160),
        payload: { tabId },
      });
    }
  };

  // Keep the queue-drain effect pointing at the latest handleSend closure.
  handleSendRef.current = handleSend;
  handleStopRef.current = handleStop;

  return (
    // `relative` is the positioning context for the bash-history panel, which
    // slides in from the right as an absolute overlay (scrim + panel) instead
    // of a flex column that shrinks the chat. The session sidebar (left) stays
    // a normal flex column.
    <div ref={rootRef} className="h-full flex relative">
      <SessionSidebar tabId={tabId} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* The header FLOATS over the transcript rather than sitting above it in
            the column. That is what lets the thread scroll underneath and be
            progressively blurred by the band the transcript draws at its top
            edge — a `backdrop-filter` can only blur what is painted behind it,
            and a header that owns its own row has nothing behind it but the
            panel background. The transcript reserves `HEADER_INSET` of top
            padding so the first row still starts below the bar. */}
        {session.messages.length === 0 ? (
          <div className="flex-1 overflow-y-auto">
            {session.transcriptLoading ? (
              <LoadingTranscriptState />
            ) : (
              <WelcomeState />
            )}
          </div>
        ) : (
          <div className="relative flex-1 min-h-0 flex flex-col">
            <Suspense fallback={<LoadingTranscriptState />}>
              <Transcript
                ref={messagesListRef}
                tabId={tabId}
                acpSessionId={acpSessionId}
                messages={filteredMessages}
                isStreaming={session.status === "running"}
                agentType={session.agentType}
                topInset={HEADER_INSET}
                onShowJumpChange={onShowJumpChange}
              />
            </Suspense>
            <div className="absolute inset-x-0 top-0 z-20">
              <ChatHeader
                tabId={tabId}
                title={headerTitle}
                roleFilter={roleFilter}
                onRoleFilterChange={setRoleFilter}
                onOpenSearch={() => setSearchPaletteOpen(true)}
                bashPanelOpen={bashPanelOpen}
                onToggleBash={() => {
                  setBashPanelOpen((v) => !v);
                  setPlansPanelOpen(false);
                }}
                plansPanelOpen={plansPanelOpen}
                onTogglePlans={() => {
                  setPlansPanelOpen((v) => !v);
                  setBashPanelOpen(false);
                }}
                onNewSession={openNewAgentChat}
              />
            </div>
          </div>
        )}

        <div className="relative">
          {/* Permission / question prompt — an inline card pinned above the
              composer (plan reviews still render as a centered modal). */}
          <PermissionModal
            tabId={tabId}
            onSendMessage={(t) => handleSend(t, [])}
          />
          {/* Bottom fade lives in the transcript; the centered floating
              row (setup pill + scroll-to-bottom) lives inside
              ChatComposer below. */}
          <ChatComposer
            tabId={tabId}
            onSend={onSendStable}
            onStop={onStopStable}
            running={isBusyAgentStatus(session.status) || hasInFlightToolCalls(session)}
            stopping={!!session.stopping}
            showJumpToBottom={showJumpToBottom}
            jumpCount={jumpCount}
            onScrollToBottom={onScrollToBottomStable}
          />
        </div>
      </div>

      {bashPanelOpen && (
        <Suspense fallback={null}>
          <BashHistoryPanel
            messages={session.messages}
            onJump={(idx) => {
              if (roleFilter !== "all") setRoleFilter("all");
              window.dispatchEvent(
                new CustomEvent("atlas:chat-jump", { detail: { index: idx } }),
              );
            }}
            onClose={() => setBashPanelOpen(false)}
          />
        </Suspense>
      )}

      {plansPanelOpen && (
        <Suspense fallback={null}>
          <PlansPanel onClose={() => setPlansPanelOpen(false)} />
        </Suspense>
      )}

      {/* Diff / tool-output detail. Gated on a narrow boolean selector so the
          chunk isn't fetched until the reader first opens it, and so this
          subscription only fires on open/close — never on a streaming chunk.
          The panel's own store owns the target, so toggling it re-renders zero
          transcript rows. */}
      {detailOpen && (
        <Suspense fallback={null}>
          <DetailPanel tabId={tabId} messages={session.messages} />
        </Suspense>
      )}

      {turnDiff !== null && turnDiff.files.length > 0 && (
        <Suspense fallback={null}>
          <GitDiffModal
            open
            onOpenChange={(o) => !o && setTurnDiff(null)}
            repoPath={useProjectStore.getState().currentProject?.path ?? ""}
            files={turnDiff.files}
            initialFile={turnDiff.initial}
            textSources={turnDiff.sources}
            title={
              turnDiff.files.length === 1
                ? (turnDiff.files[0].split("/").pop() ?? "Changes")
                : `${turnDiff.files.length} files changed`
            }
          />
        </Suspense>
      )}

      {searchPaletteOpen && (
        <Suspense fallback={null}>
          <ChatSearchPalette
            open={searchPaletteOpen}
            onOpenChange={setSearchPaletteOpen}
            messages={session.messages}
            onJump={(idx) =>
              window.dispatchEvent(
                new CustomEvent("atlas:chat-jump", { detail: { index: idx } }),
              )
            }
          />
        </Suspense>
      )}
    </div>
  );
}

/** Shown when the session's agent process died: one explicit affordance to
 *  respawn + resume. Sending a message does the same thing implicitly. */
function DisconnectedBanner({ tabId }: { tabId: string }) {
  const disconnected = useChatStore((s) => !!s.sessions[tabId]?.disconnected);
  const [restarting, setRestarting] = useState(false);
  if (!disconnected) return null;
  return (
    <div className="max-w-[720px] mx-auto mb-2 flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[12px]">
      <span className="text-[var(--text-secondary)]">
        The agent process exited. Your conversation is safe — restart to
        continue where you left off.
      </span>
      <button
        disabled={restarting}
        onClick={async () => {
          setRestarting(true);
          try {
            await rebindDisconnectedSession(tabId);
          } finally {
            setRestarting(false);
          }
        }}
        className="shrink-0 px-2.5 h-6 rounded-md bg-[var(--text-primary)] text-[var(--bg-primary)] text-[11px] font-medium hover:bg-[var(--text-secondary)] disabled:opacity-50 cursor-pointer"
      >
        {restarting ? "Restarting…" : "Restart agent"}
      </button>
    </div>
  );
}

function LoadingTranscriptState() {
  // Structural skeleton over a centered transcript-width column, so opening a
  // historical chat reads as "loading messages" instead of a blank spinner.
  return (
    <div className="h-full overflow-hidden">
      <div className="mx-auto w-full max-w-[760px]">
        <PanelSkeleton rows={6} />
      </div>
    </div>
  );
}

/**
 * Composer wrapper: the setup banner + login dialog + the real `MessageInput`.
 * Subscribes to the Claude-Code setup phase from `useClaudeSetupStore` and
 * hard-disables the input when Claude isn't installed/authed so we don't
 * surface confusing failures from inside the ACP spawn path.
 */
// Memoized: with the parent passing stable callbacks + value props, this heavy
// subtree (input, mode/agent pickers, attach menu) skips re-render on every
// streaming chunk. Its own store subscriptions (drafts/modes) still update it.
const ChatComposer = memo(function ChatComposer({
  tabId,
  onSend,
  onStop,
  running,
  stopping,
  showJumpToBottom,
  jumpCount,
  onScrollToBottom,
}: {
  tabId: string;
  onSend: (
    message: string,
    mentions: MentionData[],
    attachments?: ImageAttachment[],
  ) => void;
  onStop: () => void;
  running: boolean;
  stopping: boolean;
  showJumpToBottom: boolean;
  jumpCount: number;
  onScrollToBottom: () => void;
}) {
  // The Claude install/auth gating only applies to Claude sessions. A Codex
  // chat must not be blocked by Claude's status (Codex inherits its own
  // ~/.codex / OPENAI auth); it surfaces its own errors from the spawn path.
  const agentType = useChatStore(
    (s) => s.sessions[tabId]?.agentType ?? "claude-code",
  );
  const isClaude = agentType === "claude-code";
  const isCodex = agentType === "codex";
  const phase = useClaudeSetupStore.use.phase();

  // Codex sign-in state (Codex sessions ONLY — probing ~/.codex/auth.json for
  // any other agent both wastes a call and, worse, blocks that agent's
  // composer on Codex's auth state). `null` = still probing.
  const [codexAuthed, setCodexAuthed] = useState<boolean | null>(null);
  // Auth-classified turn failure on a Codex session → surface the sign-in
  // pill (the probe state below) instead of a generic error banner.
  useEffect(() => {
    if (!isCodex) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; agentType?: string }>).detail;
      if (detail?.agentType !== "codex") return;
      const sess = useChatStore.getState().sessions[tabId];
      if (!sess?.acpSessionId || sess.acpSessionId !== detail.sessionId) return;
      setCodexAuthed(false);
    };
    window.addEventListener("atlas:auth-required", handler);
    return () => window.removeEventListener("atlas:auth-required", handler);
  }, [isCodex, tabId]);
  const [codexSigningIn, setCodexSigningIn] = useState(false);
  useEffect(() => {
    if (!isCodex) return;
    let cancelled = false;
    codexStatus()
      .then((a) => !cancelled && setCodexAuthed(a))
      .catch(() => !cancelled && setCodexAuthed(true)); // probe failure → don't block
    return () => {
      cancelled = true;
    };
  }, [isCodex]);
  const codexNeedsAuth = isCodex && codexAuthed === false;

  // OpenCode auth is terminal-only (`opencode auth login`) and the agent still
  // works unauthenticated (free OpenCode Zen models), so nothing is probed and
  // the composer is never blocked. An auth-classified turn failure just shows
  // an instruction pill until the tab rebinds or the user dismisses it.
  const [opencodeAuthHint, setOpencodeAuthHint] = useState(false);
  useEffect(() => {
    if (agentType !== "opencode") {
      setOpencodeAuthHint(false);
      return;
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; agentType?: string }>).detail;
      if (detail?.agentType !== "opencode") return;
      const sess = useChatStore.getState().sessions[tabId];
      if (!sess?.acpSessionId || sess.acpSessionId !== detail.sessionId) return;
      setOpencodeAuthHint(true);
    };
    window.addEventListener("atlas:auth-required", handler);
    return () => window.removeEventListener("atlas:auth-required", handler);
  }, [agentType, tabId]);
  const signInCodex = async () => {
    setCodexSigningIn(true);
    try {
      const agent = await ensureAgent(CODEX_PLUGIN_ID);
      // Blocks while codex-acp runs the OpenAI browser OAuth.
      await agents.authenticate(agent.agent_id, "chatgpt");
      setCodexAuthed(await codexStatus());
    } catch (err) {
      logEvent({
        source: "atlas",
        kind: "codex-auth",
        summary: "Codex sign-in failed",
        status: "failure",
        payload: { error: String(err) },
      });
    } finally {
      setCodexSigningIn(false);
    }
  };

  const disabled = (isClaude && phase !== "ready") || codexNeedsAuth;

  const setupVisible =
    (isClaude && phase !== "ready") || codexNeedsAuth || opencodeAuthHint;
  // Node install pill (bundled-nvm). Non-blocking — informs only, doesn't
  // disable the composer. Shown for both agents since `npx` powers both.
  const nodePhase = useNodeSetupStore.use.phase();
  const nodeBusy =
    nodePhase === "installing" ||
    nodePhase === "installed" ||
    nodePhase === "failed";
  const showRow = setupVisible || nodeBusy || showJumpToBottom;

  return (
    <>
      <div className="relative">
        {/* Floating row above the composer. Pills are conditionally
            rendered (each gets its own slide-up + fade-in animation
            via `.atlas-pill-in`); when the row is empty it doesn't
            paint at all so it never blocks pointer events. */}
        {showRow && (
          <div className="pointer-events-none absolute bottom-full inset-x-0 mb-2 z-20 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-2">
              {nodeBusy && (
                <span key={`node-${nodePhase}`} className="atlas-pill-in">
                  <NodeSetupBanner />
                </span>
              )}
              {setupVisible && isClaude && (
                <span key={`setup-${phase}`} className="atlas-pill-in">
                  <ClaudeSetupBanner />
                </span>
              )}
              {codexNeedsAuth && (
                <button
                  key="codex-signin"
                  onClick={signInCodex}
                  disabled={codexSigningIn}
                  className="atlas-pill-in inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[11px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer disabled:opacity-60"
                >
                  {codexSigningIn ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <LogIn size={11} />
                  )}
                  {codexSigningIn
                    ? "Opening OpenAI sign-in…"
                    : "Sign in to Codex with ChatGPT"}
                </button>
              )}
              {opencodeAuthHint && (
                <button
                  key="opencode-auth-hint"
                  onClick={() => {
                    void copyText("opencode auth login");
                    setOpencodeAuthHint(false);
                  }}
                  title="Copies the command; run it in a terminal, then send again."
                  className="atlas-pill-in inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[11px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  <LogIn size={11} />
                  OpenCode needs auth — copy `opencode auth login`
                </button>
              )}
              {showJumpToBottom && (
                <button
                  key="jump-to-bottom"
                  onClick={onScrollToBottom}
                  title="Jump to latest"
                  style={{ backdropFilter: "blur(4px)" }}
                  className={cn(
                    "atlas-pill-in inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full",
                    "border border-[var(--border-default)] bg-[var(--bg-elevated)]",
                    "text-[11px] leading-none font-medium text-[var(--text-secondary)]",
                    "shadow-[0_2px_8px_rgba(0,0,0,0.35)] cursor-pointer transition-colors",
                    "hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                  )}
                >
                  <ChevronDown size={11} />
                  <span>
                    {jumpCount > 0
                      ? `${jumpCount} new message${jumpCount === 1 ? "" : "s"}`
                      : "Scroll to bottom"}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
        <DisconnectedBanner tabId={tabId} />
        <MessageInput
          tabId={tabId}
          onSend={onSend}
          onStop={onStop}
          running={running}
          stopping={stopping}
          disabled={disabled}
          placeholder="Ask Atlas what to do…"
        />
      </div>
      {isClaude && <ClaudeLoginDialog />}
    </>
  );
});

const WELCOME_SUGGESTIONS = [
  { text: "Analyze this codebase", Icon: Search },
  { text: "Create a new feature", Icon: Sparkles },
  { text: "Review recent changes", Icon: GitCompare },
  { text: "Write tests for...", Icon: FlaskConical },
] as const;

function WelcomeState() {
  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="w-full max-w-[440px] flex flex-col items-center text-center">
        {/* Hero: Atlas mark over a soft accent glow (radial gradient, no
            backdrop-filter — cheap + static in WKWebView). */}
        <div className="relative mb-5">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[260px] w-[260px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.16]"
            style={{
              background:
                "radial-gradient(circle, var(--accent-primary) 0%, transparent 68%)",
            }}
          />
          <AtlasIcon
            size={60}
            className="atlas-fade-in rounded-[18px] ring-1 ring-white/10 shadow-[0_12px_50px_-12px_rgba(0,0,0,0.85)]"
          />
        </div>

        <h2
          className="atlas-fade-in bg-gradient-to-b from-white to-white/55 bg-clip-text text-[22px] font-semibold tracking-tight text-transparent"
          style={{ animationDelay: "40ms" }}
        >
          Atlas
        </h2>
        <p
          className="atlas-fade-in mt-1.5 text-[13px] text-[var(--text-tertiary)]"
          style={{ animationDelay: "80ms" }}
        >
          Code with Agents. Tools, plans, and edits all live.
        </p>

        <div className="mt-7 grid w-full grid-cols-2 gap-2.5">
          {WELCOME_SUGGESTIONS.map(({ text, Icon }, i) => (
            <button
              key={text}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("atlas:chat-prefill", { detail: { text } }),
                )
              }
              style={{ animationDelay: `${120 + i * 50}ms` }}
              className="group atlas-fade-in relative flex flex-col gap-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.7)] cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <span className="grid h-7 w-7 place-items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-tertiary)] transition-colors group-hover:text-[var(--text-primary)]">
                  <Icon size={13} />
                </span>
                <ArrowRight
                  size={13}
                  className="-translate-x-1 text-[var(--text-ghost)] opacity-0 transition-all group-hover:translate-x-0 group-hover:text-[var(--text-secondary)] group-hover:opacity-100"
                />
              </div>
              <span className="text-[12px] font-medium leading-snug text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
                {text}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
