import { lazy, Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../stores/chat-store";
import { useDetailPanelStore } from "../stores/detail-panel-store";
import { appendNextStepsDirective } from "../lib/next-steps";
import { stripInjectedContext } from "../lib/atlas-context";
import { agents, ensureAgent } from "../lib/agents-api";
import { loadCachedAcpModes } from "../lib/acp-modes-cache";
import type { ImageAttachment, SessionKey } from "@/types/agents";
import {
  hasInFlightToolCalls,
  isBusyAgentStatus,
  agentTypeFromPluginId,
  pluginIdForAgent,
  CLAUDE_PERMISSION_MODES,
} from "@/types/agent";
import {
  agentMeta,
  catalogEntry as agentCatalogEntry,
  installedExternals,
} from "@/features/agents/lib/agent-meta";
import { bindFailureAction, errInfo, promptSignIn } from "../lib/agent-signin";
import { toast } from "sonner";

/** Tab+agent pairs whose bind failure has already been surfaced, so the
 *  focus-triggered retry doesn't re-toast the same error on every focus.
 *  Cleared for a pair once its bind finally succeeds. */
const reportedBindFailures = new Set<string>();

/** Tab+agent pairs we have ALREADY walked through sign-in once.
 *
 *  Without this the sign-in flow loops forever: the retry callback clears
 *  `reportedBindFailures` so the rebind can report afresh, so a rebind that
 *  fails on auth AGAIN re-opens the dialog, and completing it retries, and so
 *  on. That is not hypothetical — plenty of registry agents advertise an auth
 *  method that does not actually authenticate them (`autohand`'s only method is
 *  `npm install -g autohand-cli`, which installs a CLI and leaves the agent
 *  still demanding a login). Offering the dialog once and then showing the
 *  agent's own message is the honest end state.
 *
 *  Cleared alongside `reportedBindFailures` when a bind finally succeeds, so a
 *  genuine re-auth later in the session still gets the dialog. */
const signInAttempted = new Set<string>();
import { composePrompt, type MentionData } from "../lib/mentions";
import { usePaneFind } from "../lib/use-pane-find";
import { MessageInput } from "./message-input";
import { SessionSidebar } from "./session-sidebar";
import { ChatHeader } from "./chat-header";
import { openAgentSession, openNewAgentChat } from "../lib/open-agent-session";
import { workspacePathForTab } from "../lib/tab-workspace";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchTextDiff } from "@/features/git/lib/git-diff-api";
import { OPEN_TURN_DIFF_EVENT, type TurnDiffRequest } from "../lib/open-turn-diff";
import { collectTurnEdits } from "../lib/turn-edits";

/** Height the floating header occupies — the transcript pads its content by
 *  this much so the first row clears the bar. Must match `ChatHeader`'s bar. */
const HEADER_INSET = 46;
import { PermissionModal } from "./permission-modal";
import { ElicitationModal } from "./elicitation-modal";

// Both panels are modal-style and never visible on first paint. Lazy so
// they don't add to the initial chunk.
const BashHistoryPanel = lazy(() =>
  import("./bash-history-panel").then((m) => ({ default: m.BashHistoryPanel })),
);
const PlansPanel = lazy(() => import("./plans-panel").then((m) => ({ default: m.PlansPanel })));
const ChatSearchPalette = lazy(() =>
  import("./chat-search-palette").then((m) => ({
    default: m.ChatSearchPalette,
  })),
);

// The transcript transitively imports the markdown vendor chunk
// (`remark-gfm` + `rehype-highlight`, ~330 KB raw / 101 KB gzip). Lazy so an
// empty-chat first paint doesn't preload it; loads the first time this tab has
// messages.
const Transcript = lazy(() => import("./transcript").then((m) => ({ default: m.Transcript })));
import type { TranscriptHandle } from "./transcript";
// Diffs + tool output live here rather than inline in the thread — see the
// module header for why that's a perf decision as much as a UX one.
const DetailPanel = lazy(() => import("./detail-panel").then((m) => ({ default: m.DetailPanel })));
// Full-screen side-by-side diff for a turn's changes. Lazy: it pulls the
// virtualizer + the diff-highlight worker, and most sessions never open it.
const GitDiffModal = lazy(() =>
  import("@/features/git/components/git-diff-modal").then((m) => ({
    default: m.GitDiffModal,
  })),
);
import { Sparkles, Search, ChevronDown, ArrowRight, GitCompare, FlaskConical } from "lucide-react";
import { AtlasIcon } from "@/components/atlas-icon";
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
    const cwd = sess.workingDirectory || useProjectStore.getState().currentProject?.path || "/";
    let key: SessionKey;
    if (sess.acpSessionId) {
      try {
        key = await agents.loadSession(agent.agent_id, sess.acpSessionId, cwd);
      } catch (err) {
        console.warn("resume after disconnect failed; starting fresh:", err);
        key = (await agents.newSession(agent.agent_id, cwd)).key;
      }
    } else {
      key = (await agents.newSession(agent.agent_id, cwd)).key;
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

export function ChatPanel({ tabId }: ChatPanelProps) {
  // Subscribe to ONLY this tab's session. Streaming chunks on other tabs
  // shouldn't repaint this panel — immer preserves reference equality for
  // unchanged sub-paths, so `s.sessions[tabId]` only changes when this tab
  // mutates.
  const session = useChatStore((s) => s.sessions[tabId]);
  const { createSession, addMessage, updateSessionStatus, setSessionTitle, clearElicitation } =
    useChatStore.use.actions();
  // Narrow subscription — an unanswered `elicitation/create` (P3.3).
  const pendingElicitation = useChatStore((s) => s.sessions[tabId]?.pendingElicitation);

  // P3.4: only offer "branch from here" when the bound agent advertised
  // `sessionCapabilities.fork`. Gated on data, never on an agent name.
  const canFork = useChatStore((s) => {
    const sess = s.sessions[tabId];
    if (!sess?.acpAgentId || !sess.acpSessionId || !sess.agentType) return false;
    return agentCatalogEntry(sess.agentType)?.supportsFork === true;
  });

  /** Fork the bound session and open the branch in a new tab, so the thread
   *  that got here stays intact — which is the entire point of forking. */
  const onForkSessionStable = useCallback(() => {
    void (async () => {
      const sess = useChatStore.getState().sessions[tabId];
      if (!sess?.acpAgentId || !sess.acpSessionId) return;
      try {
        const forked = await agents.forkSession({
          agent_id: sess.acpAgentId,
          session_id: sess.acpSessionId,
        });
        if (!forked) {
          toast.error("This agent cannot branch a session.");
          return;
        }
        // Open the branch in its own tab so the thread that got here stays
        // intact — which is the entire point of forking.
        await openAgentSession({
          acpSessionId: forked,
          title: `${sess.title ?? "Session"} (branch)`,
          cwd: useProjectStore.getState().currentProject?.path ?? "",
          agentType: sess.agentType,
        });
      } catch (err) {
        toast.error(errInfo(err).message);
      }
    })();
  }, [tabId]);
  const [roleFilter, setRoleFilter] = useState<"all" | "user" | "assistant">("all");
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
        ? (session?.messages ?? [])
        : (session?.messages ?? []).filter((m) => m.role === roleFilter),
    [session?.messages, roleFilter],
  );

  const acpSessionId = session?.acpSessionId ?? "";

  // A fresh chat starts on the native agent and starts immediately: the
  // default needs no probe, so there is no window in which the tab has to sit
  // session-less waiting to find out which agent it is.
  useEffect(() => {
    if (!session) createSession(tabId);
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
        // Resolve cwd from THIS tab's workspace, not the global currentProject:
        // background workspaces keep their chat panels mounted, so a bind that
        // fires after a workspace switch (failed-bind retry, agent change)
        // would otherwise create the session against the WRONG repo — and a
        // "/" fallback would dodge the running-workspace eviction guard.
        const cwd =
          workspacePathForTab(tabId) ?? useProjectStore.getState().currentProject?.path ?? "/";
        const init = await agents.newSession(agent.agent_id, cwd);
        const key = init.key;
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
        const session = useChatStore.getState().sessions[tabId];
        const selectedMode = session?.claudePermissionMode ?? "default";
        // `default` means the user has not overridden the agent. Preserve the
        // mode resolved by Claude/Codex from their own user-level config.
        const requestedClaudeMode = session?.claudePermissionModeExplicit
          ? selectedMode
          : undefined;
        const requestedAcpMode = session?.acpModeExplicit ? session.acpCurrentMode : undefined;
        const requestedMode = nowAt === "claude-code" ? requestedClaudeMode : requestedAcpMode;
        const mode = requestedMode ?? init.current_mode;
        const modeAdvertised =
          !mode ||
          init.available_modes.length === 0 ||
          init.available_modes.some((m) => m.id === mode);
        const effectiveMode = modeAdvertised ? mode : init.current_mode;
        if (effectiveMode && effectiveMode !== init.current_mode) {
          try {
            await agents.setMode(key, effectiveMode);
          } catch (err) {
            console.warn("setMode at session create failed:", err);
          }
          if (cancelled) return;
        }
        // Seed the store before binding: binding is the point at which queued
        // sends become eligible, so the first prompt sees the agent's actual
        // default instead of a hard-coded Atlas fallback.
        if (!cancelled) {
          const actions = useChatStore.getState().actions;
          if (
            nowAt === "claude-code" &&
            (effectiveMode ?? init.current_mode) &&
            CLAUDE_PERMISSION_MODES.includes(
              (effectiveMode ?? init.current_mode) as (typeof CLAUDE_PERMISSION_MODES)[number],
            )
          ) {
            actions.hydrateClaudePermissionMode(
              tabId,
              (effectiveMode ?? init.current_mode) as (typeof CLAUDE_PERMISSION_MODES)[number],
            );
          } else if (nowAt !== "claude-code" && init.available_modes.length > 0) {
            actions.setAcpModes(tabId, effectiveMode, init.available_modes, nowAt);
          }
        }
        useChatStore.getState().actions.setAcpBinding(tabId, agent.agent_id, key.session_id, cwd);
        // Bound successfully — re-arm the failure toast so a LATER breakage
        // (agent crashes, gets uninstalled) is reported again rather than
        // swallowed by the earlier dedupe. Same for the sign-in offer: a token
        // that expires later in the session deserves the dialog again.
        reportedBindFailures.delete(`${tabId}:${pluginId}`);
        signInAttempted.delete(`${tabId}:${pluginId}`);
        // Seed the composer mode picker from the freshly-created session's
        // advertised modes (Codex: read-only / auto / full-access). The modes
        // are seeded into the Rust SessionState by `new_session`, so the
        // snapshot here already carries them. Claude ignores these in favour
        // of its own permission pill.
        try {
          const snap = await agents.snapshotMeta(key);
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
                  agentTypeFromPluginId(snap.plugin_id),
                );
            }
            // Seed the ACP model picker (Claude Code / Codex) from the snapshot's
            // advertised models. Empty when the agent exposes no model selection.
            if (models.length > 0) {
              useChatStore.getState().actions.setAcpModels(tabId, snap.current_model, models);
            }
            // Seed the slash-command list the same way. An
            // `available_commands_update` fired between `session/new` and the
            // binding is dropped by the delta router (no tab matches yet), and
            // nothing re-emits it — the snapshot is the recovery path, exactly
            // as for modes/models. Rust buffers pre-install notifications, so
            // by the time this snapshot lands the commands are in state.
            useChatStore
              .getState()
              .actions.setAcpAvailableCommands(tabId, snap.available_commands ?? []);
            // And the config-option knobs (#32). The `session/new`
            // advertisement lives only in the backend cell — a follow-up
            // notification is optional and most agents never send one, so
            // without this the effort pill and every other knob simply never
            // appeared. This also heals the early-delta drop: any
            // `config_options_updated` emitted before the tab was bound is
            // re-covered by this snapshot, which is fetched after bind.
            useChatStore.getState().actions.setAcpConfigOptions(tabId, snap.config_options ?? []);
            // Boot finished (with or without modes) — drop the loading state.
            useChatStore.getState().actions.setAcpModesPending(tabId, false);
          }
        } catch (err) {
          console.warn("snapshot for modes failed:", err);
          if (!cancelled) useChatStore.getState().actions.setAcpModesPending(tabId, false);
        }
      } catch (err) {
        console.warn("Agent session creation failed:", err);
        // Bind failed (couldn't set the agent up / spawn error). This used to
        // be console-only, so a user whose agent wouldn't start just saw a dead
        // composer with no reason given. The backend's message is the useful
        // one — `explain_spawn_failure` names the agent and the fix (check your
        // connection, or sign in with `cursor-agent login`). Deduped per
        // tab+agent because the focus handler retries this bind.
        if (!cancelled) {
          useChatStore.getState().actions.setAcpModesPending(tabId, false);
          const at = useChatStore.getState().sessions[tabId]?.agentType;
          const key = `${tabId}:${pluginIdForAgent(at)}`;
          if (!reportedBindFailures.has(key)) {
            reportedBindFailures.add(key);
            // Cursor (and friends) reject `session/new` when signed out, so the
            // "you need to sign in" case lands HERE, not on the turn-failure
            // route that raises `atlas:auth-required`. Offer the one-click fix
            // instead of dumping a raw protocol error, and rebind once it lands.
            // Only ONCE per tab+agent — see `signInAttempted`.
            const action = bindFailureAction({
              agentType: at,
              err,
              alreadyAttempted: signInAttempted.has(key),
            });
            if (action === "sign-in" && at) {
              signInAttempted.add(key);
              // `reason` is what lets the dialog offer in-app key entry rather
              // than the agent's own (often unusable) auth methods.
              promptSignIn(at, {
                reason: errInfo(err).message,
                onSignedIn: () => {
                  reportedBindFailures.delete(key);
                  void ensureBound();
                },
                // Dismissed without signing in: re-arm reporting only. The
                // dedupe key used to stay set forever, silently swallowing
                // every subsequent bind failure for this tab+agent.
                onDismissed: () => reportedBindFailures.delete(key),
              });
            } else if (action === "signed-in-but-refused" && at) {
              // Signed in already and STILL refused. Say so, and surface the
              // agent's own words — it is the only thing that can explain what
              // else it wants.
              toast.error(
                `${agentMeta(at).label} still reports no credentials after signing in. ` +
                  `It said: ${errInfo(err).message}`,
              );
            } else {
              // `errInfo`, not String(err): these commands reject with a
              // structured `{message, kind}`, which stringifies to
              // "[object Object]".
              toast.error(errInfo(err).message);
            }
          }
        }
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
        const snap = await agents.snapshotMeta({
          agent_id: agentId,
          session_id: acpSessionId,
        });
        if (cancelled) return;
        const models = snap.available_models ?? [];
        console.debug("[acp-models] backfill", {
          agent: session?.agentType,
          models: models.length,
        });
        if (models.length > 0) {
          useChatStore.getState().actions.setAcpModels(tabId, snap.current_model, models);
        } else {
          // An empty snapshot means either that this agent advertises no model
          // select, or that its config options had not landed yet. Fall back to
          // the per-agent cache — same agent, so no cross-agent leak — so the
          // picker is populated either way. The cache holds the LIST only; the
          // current model comes from the session itself (`acp-models-cache`).
          // Re-read the agent type from the store — the closed-over `session`
          // is the render-time value and can be stale after the await.
          const at = useChatStore.getState().sessions[tabId]?.agentType ?? "claude-code";
          const cached = loadCachedAcpModels(at);
          if (cached && cached.availableModels.length > 0) {
            useChatStore.getState().actions.setAcpModels(tabId, null, cached.availableModels);
          }
        }
        // Same backfill for slash commands: a session bound before this
        // mount (HMR, resume, tab restore) may have missed its
        // `available_commands_update` — the snapshot carries the list.
        if (useChatStore.getState().sessions[tabId]?.availableCommands === undefined) {
          useChatStore
            .getState()
            .actions.setAcpAvailableCommands(tabId, snap.available_commands ?? []);
        }
        // And the knobs, for the same reasons (#32).
        if (useChatStore.getState().sessions[tabId]?.acpConfigOptions === undefined) {
          useChatStore.getState().actions.setAcpConfigOptions(tabId, snap.config_options ?? []);
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

  // The other-agent model prefetch is gone with `warm-acp-models`. It iterated
  // a STATIC list of five agent names to decide who to warm — the last such
  // list on the chat path (ADR-0002) — and opened a throwaway session on each
  // to harvest its model list. The persisted cache still drives the picker for
  // any agent seen before; one that has not been opened this session fills its
  // picker when it is.

  // Shift+Tab → cycle the agent permission mode. Registered on the window in
  // capture phase so the browser's default focus traversal never steals it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
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
  // auth), so paying it ahead of time makes the actual switch fast. Runs once
  // per app session, deferred and staggered so it never competes with the
  // primary bind.
  //
  // Two gates, and both matter. The agent must be INSTALLED — a hardcoded list
  // of agent names here would have spawned agents the user never asked for,
  // which is exactly what ADR-0002 forbids — and the user must have used it
  // before (a persisted modes cache exists), so we never spawn one they only
  // ever ignore.
  useEffect(() => {
    if (acpPrewarmStarted) return;
    acpPrewarmStarted = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    installedExternals().forEach((agent, i) => {
      const at = agent.agentType;
      if (!loadCachedAcpModes(at)) return; // never used → skip
      timers.push(
        setTimeout(
          () => {
            void ensureAgent(agent.id).catch(() => {
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
  const handleSendRef = useRef<((content: string, mentions: MentionData[]) => void) | null>(null);
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
  const onScrollToBottomStable = useCallback(() => messagesListRef.current?.scrollToBottom(), []);
  // Same stable-identity discipline for the OTHER memo'd siblings that render
  // once per streaming frame with ChatPanel: fresh inline closures here would
  // defeat their memo() exactly like they would the composer's.
  const onPermissionSend = useCallback((t: string) => handleSendRef.current?.(t, []), []);
  const onOpenSearchStable = useCallback(() => setSearchPaletteOpen(true), []);
  const onToggleBashStable = useCallback(() => {
    setBashPanelOpen((v) => !v);
    setPlansPanelOpen(false);
  }, []);
  const onTogglePlansStable = useCallback(() => {
    setPlansPanelOpen((v) => !v);
    setBashPanelOpen(false);
  }, []);
  const onNewSessionStable = useCallback(() => openNewAgentChat(), []);
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

  // No session yet. Normally a single frame (the effect above creates it on
  // mount); on a first-ever launch it also covers the brief wait for the Claude
  // Code probe that decides which agent this chat starts on. Show the transcript
  // skeleton rather than a blank pane so that wait doesn't read as a broken tab.
  if (!session) {
    return (
      <div ref={rootRef} className="h-full overflow-hidden">
        <div className="mx-auto w-full max-w-[760px] pt-[46px]">
          <PanelSkeleton rows={6} />
        </div>
      </div>
    );
  }

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
      setSessionTitle(tabId, actualContent.slice(0, 40) + (actualContent.length > 40 ? "..." : ""));
    }

    updateSessionStatus(tabId, "running");

    // Expand mentions. Bodies that have no URI (notes, papers, past sessions)
    // still append under a fenced `## @ref` section; file/folder mentions come
    // back as structured `resourceLinks` and ride as ACP `ResourceLink` blocks
    // instead (P2.1) — see `mentions.ts::composePrompt`.
    let wirePrompt: string;
    let resourceLinks: { uri: string; name: string }[] = [];
    try {
      const composed = await composePrompt(actualContent, mentions);
      wirePrompt = composed.prose;
      resourceLinks = composed.resourceLinks;
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

    // Non-blocking send: returns the instant the prompt is queued onto the
    // SessionWorker. The atlas:agents `turn_finished` delta flips status
    // back to idle + handles empty-turn placeholder via `applyAgentDelta`.
    const key: SessionKey = {
      agent_id: bound.acpAgentId,
      session_id: bound.acpSessionId,
    };
    try {
      await agents.send(key, wirePrompt, attachments, resourceLinks);
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
            {session.transcriptLoading ? <LoadingTranscriptState /> : <WelcomeState />}
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
                onOpenSearch={onOpenSearchStable}
                bashPanelOpen={bashPanelOpen}
                onToggleBash={onToggleBashStable}
                plansPanelOpen={plansPanelOpen}
                onTogglePlans={onTogglePlansStable}
                // Zero-arg wrapper, NOT a bare reference: React would call
                // openNewAgentChat(SyntheticMouseEvent) and the event object
                // sailed through `agent?` into the store as agentType —
                // poisoning the bind ("JSON.stringify cannot serialize cyclic
                // structures" from agents_spawn) and killing the composer.
                onNewSession={onNewSessionStable}
                onForkSession={canFork ? onForkSessionStable : undefined}
              />
            </div>
          </div>
        )}

        <div className="relative">
          {/* Permission / question prompt — an inline card pinned above the
              composer (plan reviews still render as a centered modal). */}
          <PermissionModal tabId={tabId} onSendMessage={onPermissionSend} />
          {pendingElicitation && (
            <ElicitationModal
              key={pendingElicitation.requestId}
              pending={pendingElicitation}
              onClose={() => clearElicitation(tabId)}
            />
          )}
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
              window.dispatchEvent(new CustomEvent("atlas:chat-jump", { detail: { index: idx } }));
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
              window.dispatchEvent(new CustomEvent("atlas:chat-jump", { detail: { index: idx } }))
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
        The agent process exited. Your conversation is safe — restart to continue where you left
        off.
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
 * Composer wrapper: the login dialog + the real `MessageInput`.
 *
 * It no longer gates on anything. Two agent-specific surfaces used to live
 * here: a Claude setup banner that hard-disabled the input until Claude Code
 * was installed and authed, and a Codex sign-in pill driven by a probe of
 * `~/.codex/auth.json`. Both are gone (ADR-0002). A composer disabled by one
 * agent's readiness was a trap, because the agent switcher lives INSIDE it —
 * the user could not switch to an agent that WAS ready. Failures now arrive as
 * `atlas:auth-required` and route through `canSignIn`, which asks the catalog
 * whether an agent has a sign-in, never which agent it is.
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
  onSend: (message: string, mentions: MentionData[], attachments?: ImageAttachment[]) => void;
  onStop: () => void;
  running: boolean;
  stopping: boolean;
  showJumpToBottom: boolean;
  jumpCount: number;
  onScrollToBottom: () => void;
}) {
  // OpenCode / Cursor / Kilo auth used to raise a "copy `cursor-agent login`"
  // pill here. It is gone: `atlas:auth-required` now routes ONLY to the
  // AgentLoginDialog (see message-input.tsx), which runs the login for the
  // user instead of asking them to run it themselves. The pill also gave
  // advice that was wrong on the machines that needed it most — when Atlas
  // downloaded the CLI into its app-data dir, there was no such command on the
  // user's PATH to run. The dialog's error phase now shows the real absolute
  // path as a manual fallback.

  return (
    <>
      <div className="relative">
        {/* Floating row above the composer. Pills are conditionally
            rendered (each gets its own slide-up + fade-in animation
            via `.atlas-pill-in`); when the row is empty it doesn't
            paint at all so it never blocks pointer events. */}
        {showJumpToBottom && (
          <div className="pointer-events-none absolute bottom-full inset-x-0 mb-2 z-20 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-2">
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
          placeholder="Ask Atlas what to do…"
        />
      </div>
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
              background: "radial-gradient(circle, var(--accent-primary) 0%, transparent 68%)",
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
                window.dispatchEvent(new CustomEvent("atlas:chat-prefill", { detail: { text } }))
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
