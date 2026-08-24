import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { X, MessageSquare, Search, PanelLeft, Plus, History, Archive } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { isBusyAgentStatus, agentTypeFromPluginId } from "@/types/agent";
import {
  ClaudeIcon,
  CodexIcon,
  OpenCodeIcon,
  CursorIcon,
  KiloIcon,
  ExternalAgentIcon,
  AgentMonogram,
} from "@/components/agent-icons";
import { pluginIdForAgent, type SwitchableAgent } from "@/types/agent";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { AtlasLoader } from "@/components/atlas-loader";
import { timeAgo } from "@/lib/time-ago";
import { ThreadHistoryView } from "./thread-history-view";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { bumpLoadToken, isLoadStale } from "../lib/load-tokens";
import {
  archiveThread,
  deleteThread,
  onThreadsChanged,
  threadProjects,
  type ThreadRow,
} from "../lib/history-api";
import { getAgentSync } from "../lib/agents-api";
import { AtlasIcon } from "@/components/atlas-icon";
import { useRecentChatsStore } from "@/features/workspaces/stores/recent-chats-store";
import { resumeThreadFast, ResumeError } from "../lib/resume-session";

/** One key for the whole sidebar: history is one store, so there is one query. */
const THREAD_PROJECTS_KEY = ["thread-projects"] as const;

/** Short per-row agent tag. "claude" doubles as the legacy default for rows
 *  with no metadata, so the mapping from AgentType is centralised here instead
 *  of repeated ternaries that silently mislabel new agents. */
type SidebarAgent = "claude" | "codex" | "opencode" | "cursor" | "kilo" | "cersei" | (string & {});

export function sidebarAgentOf(agentType: string | undefined): SidebarAgent {
  // A live codex-acp session and the ~/.codex disk row it produces MUST fold
  // into one band, or twin suppression, row icon, and delete routing all miss
  // each other (claude-acp folds via the startsWith below).
  if (agentType === "codex-acp") return "codex";
  if (
    agentType === "codex" ||
    agentType === "opencode" ||
    agentType === "cursor" ||
    agentType === "kilo" ||
    agentType === "cersei"
  )
    return agentType;
  if (!agentType || agentType === "custom" || agentType.startsWith("claude")) return "claude";
  // Registry-installed external agent: its plugin id IS its identity.
  return agentType;
}

/** One history row, as the list renders it. Used by the sidebar's own list and
 *  by the history view handing a row back to be opened — one builder, so the
 *  two cannot disagree about what a row is. */
function itemFromThread(thread: ThreadRow, projectName: string, cwd: string): SidebarItem {
  return {
    // Never a draft: `threads_projects` lists only threads that have been sent
    // to, so the session id is always there.
    id: thread.sessionId ?? "",
    threadId: thread.threadId,
    kind: "agent",
    title: thread.title,
    projectHeading: null,
    projectName,
    lastUpdated: thread.updatedAt,
    agent: sidebarAgentOf(thread.agentId),
    elsewhere: !thread.folderPaths.includes(cwd),
    // The thread's own directory — where it resumes.
    cwd: thread.folderPaths[0] ?? "",
  };
}

/** Band → the registry id resume must spawn through. The claude/codex bands
 *  come from disk listings that predate any live session, so they need an
 *  explicit mapping back to the registry entries that own those stores. The
 *  old values ("claude-code"/"codex") named plugin ids the registry-only port
 *  deleted, so resuming those rows spawned UnknownSpec — a silent dead click. */
export const AGENT_TYPE_BY_SIDEBAR: Partial<Record<string, SwitchableAgent>> = {
  claude: "claude-acp",
  codex: "codex-acp",
  opencode: "opencode",
  cursor: "cursor",
  kilo: "kilo",
  cersei: "cersei",
};

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M". */

interface SidebarItem {
  /** The agent's session id, or a stand-in while the thread is still a draft.
   *  Only used to match the row against a live tab. */
  id: string;
  /** Atlas's own id for the conversation — what opening and deleting use. */
  threadId: string;
  kind: "agent";
  title: string;
  lastUpdated: string | null;
  /** Which agent ran this session (drives the row icon). */
  agent: SidebarAgent;
  /** The project's name, on the first row of a run of its threads. Stamped
   *  after filtering, so it follows what is actually on screen. */
  projectHeading: string | null;
  /** The project this thread belongs to, named on every row that is shown
   *  outside the open project. */
  projectName: string;
  /** This thread belongs to a project other than the one that is open. */
  elsewhere: boolean;
  /** The thread's own working directory — where it resumes, which is not
   *  necessarily the project that happens to be open. */
  cwd: string;
}

interface SessionSidebarProps {
  tabId: string;
  /**
   * Where this list is being rendered.
   *
   * `"sidebar"` (default) — the resizable left column inside the chat panel,
   * gated on `chatSidebar.visible`.
   *
   * `"dropdown"` — the body of the header's session picker. Same data, same
   * handlers, different chrome: no fixed width, no resize handle, no border,
   * and NOT gated on the sidebar's visibility (the picker exists precisely so
   * history is reachable with the sidebar closed).
   *
   * This is a variant rather than a second component on purpose. Reading the
   * list is one query now, but OPENING a row is still a hundred lines of
   * resume logic with several hard-won edge cases (orphan tabs, a running tab
   * that must not be overwritten, stale clicks). Duplicating that would
   * guarantee the two drift.
   */
  variant?: "sidebar" | "dropdown";
  /** Called after a row is opened — lets the picker close itself. */
  onOpened?: () => void;
}

// memo: ChatPanel re-renders once per streaming rAF flush (whole-session
// subscription), and this whole body was re-executed with it every frame.
// Props are stable from ChatPanel
// (tabId string; the dropdown variant passes its own onOpened, whose identity
// its parent controls), so memo confines re-runs to this component's own
// subscriptions.
export const SessionSidebar = memo(function SessionSidebar({
  tabId,
  variant = "sidebar",
  onOpened,
}: SessionSidebarProps) {
  const asDropdown = variant === "dropdown";
  const queryClient = useQueryClient();
  const project = useProjectStore.use.currentProject();
  // `currentProject` is a legacy field that's transiently null during boot and
  // workspace switches (it's repopulated by a fire-and-forget `void switchTo`).
  // When it's null, `cwd` was "" → every history query (gated on
  // `cwd.length > 0`) returned [] → the sidebar showed only ephemeral live rows.
  // Fall back to the active workspace's path (the real source of truth).
  const activeWorkspaceId = useWorkspaceStore.use.activeWorkspaceId();
  const workspaces = useWorkspaceStore.use.workspaces();
  const resolvedCwd =
    project?.path ?? workspaces.find((w) => w.id === activeWorkspaceId)?.path ?? "";
  // STICKY cwd. It no longer keys any query — history is one app-level store —
  // but it still decides which project's threads sort to the top and which
  // directory a resumed thread binds against, and both would flicker if it
  // collapsed to "" for a render. Even with the workspace fallback,
  // `currentProject` and
  // `activeWorkspaceId`/`workspaces` can momentarily DISAGREE mid-switch,
  // collapsing `resolvedCwd` to "" for a render or two. Hold the last NON-EMPTY
  // cwd across those blips; only clear it when there is genuinely no project
  // open (zero workspaces).
  const lastCwdRef = useRef("");
  if (resolvedCwd) {
    lastCwdRef.current = resolvedCwd;
  } else if (workspaces.length === 0) {
    lastCwdRef.current = "";
  }
  const cwd = lastCwdRef.current;

  // Stable signature string of the slim per-tab fields the sidebar reads.
  // Returning a primitive means zustand's default Object.is equality short-
  // circuits cleanly — the sidebar only re-runs its render when one of the
  // tracked fields actually changes, NOT on every streaming chunk (those
  // mutate `messages[].content` and don't touch any field in the signature).
  //
  // The earlier `useShallow(... -> Record<TabId, { nested }> ...)` version
  // looked sensible but blew up: useShallow only does one-level shallow eq,
  // and the inner objects were freshly allocated per call → never equal →
  // infinite-loop re-render via useSyncExternalStore.
  const sessionsSignature = useChatStore((s) => {
    const keys = Object.keys(s.sessions).sort();
    let sig = "";
    for (const k of keys) {
      const x = s.sessions[k];
      sig +=
        k +
        "|" +
        x.title +
        "|" +
        x.status +
        "|" +
        (x.acpAgentId ?? "") +
        "|" +
        (x.acpSessionId ?? "") +
        "|" +
        x.updatedAt +
        "|" +
        (x.firstUserContent ?? "") +
        "|" +
        (x.userMessageCount ?? 0) +
        "|" +
        (x.agentType ?? "claude-code") +
        "|" +
        (x.workingDirectory ?? "") +
        "|" +
        (x.messages.length > 0 ? 1 : 0) +
        "\n";
    }
    return sig;
  });
  const tabSummaries = useMemo(() => {
    // Pull current state non-reactively. The signature above is what gates
    // recomputation; `getState()` here just gives us the rich object form.
    const sessions = useChatStore.getState().sessions;
    const out: Record<
      string,
      {
        id: string;
        title: string;
        status: string;
        acpAgentId: string | undefined;
        acpSessionId: string | undefined;
        updatedAt: string;
        firstUserContent: string;
        userMessageCount: number;
        agentType: string;
        workingDirectory: string;
        hasAnyMessage: boolean;
      }
    > = {};
    for (const [tid, sess] of Object.entries(sessions)) {
      out[tid] = {
        id: sess.id,
        title: sess.title,
        status: sess.status,
        acpAgentId: sess.acpAgentId,
        acpSessionId: sess.acpSessionId,
        updatedAt: sess.updatedAt,
        firstUserContent: sess.firstUserContent ?? "",
        userMessageCount: sess.userMessageCount ?? 0,
        agentType: sess.agentType ?? "claude-code",
        workingDirectory: sess.workingDirectory ?? "",
        hasAnyMessage: sess.messages.length > 0,
      };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature]);
  const activeSession = tabSummaries[tabId];
  const activeAcpId = activeSession?.acpSessionId;

  const {
    replaceMessages,
    setAcpBinding,
    setAcpModes,
    setAcpModels,
    setAcpConfigOptions,
    setAcpAvailableCommands,
    setSessionAgentType,
    clearSession,
    setSessionTitle,
    setTranscriptLoading,
    setResumePending,
    createSession,
    hydrateSessionSnapshot,
  } = useChatStore.use.actions();

  const chatSidebar = useLayoutStore.use.chatSidebar();
  const { toggleChatSidebar, setChatSidebarWidth, addTab, setActiveTab } =
    useLayoutStore.use.actions();

  const [search, setSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  // Atlas's own history — the only source. It used to be six: Claude's JSONL
  // directory, Codex's SQLite, Kilo's SQLite, Cersei's store, Atlas's
  // transcripts and a live ACP `session/list`, merged by session id. That
  // coupled the sidebar to four private storage formats and meant an agent
  // nobody had written a reader for had no history at all (ADR-0001).
  //
  // No polling and no file watching: the store says when it changed.
  const {
    data: projects = [],
    isLoading,
    isSuccess: historyReady,
  } = useQuery({
    queryKey: THREAD_PROJECTS_KEY,
    queryFn: threadProjects,
    staleTime: 30_000,
    refetchInterval: false,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: THREAD_PROJECTS_KEY });
    };
    const unlistenPromise = onThreadsChanged(invalidate);
    window.addEventListener("focus", invalidate);
    return () => {
      unlistenPromise.then((u) => u());
      window.removeEventListener("focus", invalidate);
    };
  }, [queryClient]);

  // The open project first, then everywhere else by how recently it was worked
  // in. Threads from other worktrees are listed and resumable without
  // switching to them — that is what an app-level store buys.
  const items = useMemo<SidebarItem[]>(() => {
    const ordered = [...projects].sort((a, b) => {
      const aHere = a.paths.includes(cwd) ? 0 : 1;
      const bHere = b.paths.includes(cwd) ? 0 : 1;
      return aHere - bHere;
    });
    return ordered.flatMap((project) =>
      project.threads.map((thread) => itemFromThread(thread, project.name, cwd)),
    );
  }, [projects, cwd]);

  // Self-heal the workspace panel's persisted "Chats" list for THIS project.
  // That list (`atlas-recent-chats`) is recorded on agent activity and never
  // re-validated, so rows for sessions deleted elsewhere linger forever. Now
  // that history is one store, "does this still exist" is one lookup.
  useEffect(() => {
    if (!cwd || !historyReady) return;
    const known = new Set<string>();
    for (const project of projects) {
      for (const thread of project.threads) {
        if (thread.sessionId) known.add(thread.sessionId);
      }
    }
    const liveTabs = new Set<string>();
    for (const s of Object.values(tabSummaries)) {
      if (s.acpSessionId) known.add(s.acpSessionId);
      liveTabs.add(s.id);
    }
    const { items: recent, actions } = useRecentChatsStore.getState();
    // Grace period: a freshly-active row can be ahead of the store's own
    // change event, so judging it against a stale snapshot would purge a real
    // chat. Only rows quiet for a minute are eligible.
    const cutoff = Date.now() - 60_000;
    for (const c of recent) {
      if (c.projectPath !== cwd) continue;
      if (c.updatedAt > cutoff) continue;
      const alive = c.acpSessionId ? known.has(c.acpSessionId) : liveTabs.has(c.tabId);
      if (!alive) actions.remove(c.tabId);
    }
  }, [cwd, historyReady, projects, tabSummaries]);

  // Sessions currently running (used to show a spinner on the matching row).
  // Keys MUST match the `id`s used when constructing `items` above, otherwise
  // the spinner never lights up. Once an agent session is bound we key by
  // `acpSessionId`; while it's still spawning we use the synthetic
  // `live-${tabId}` placeholder.
  const runningKeys = useMemo(() => {
    const set = new Set<string>();
    for (const s of Object.values(tabSummaries)) {
      if (!isBusyAgentStatus(s.status)) continue;
      const liveId = s.acpSessionId ?? `live-${s.id}`;
      set.add(`agent:${liveId}`);
    }
    return set;
  }, [tabSummaries]);

  // Headings are stamped AFTER filtering, not before: a search that hides a
  // project's first row would otherwise take the project's name with it and
  // leave the rest of its threads under the previous project's heading.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matching = q ? items.filter((it) => it.title.toLowerCase().includes(q)) : items;
    const named = matching.length > 0 && new Set(matching.map((it) => it.projectName)).size > 1;
    let previous: string | null = null;
    return matching.map((item) => {
      const heading = named && item.projectName !== previous ? item.projectName : null;
      previous = item.projectName;
      return { ...item, projectHeading: heading };
    });
  }, [items, search]);

  // Singleton model: "New chat" always starts a fresh session in the CURRENT
  // tab (never a second tab). Shared with ⌘T / the palette / the context menu.
  const handleNewChat = () => openNewAgentChat();

  const handleOpenAgent = (item: SidebarItem) => {
    const storeSnapshot = useChatStore.getState().sessions;

    // Live-focus: if an open tab already holds this conversation, focus it.
    // Only a tab that still EXISTS — a closed chat leaves its session behind,
    // and focusing that dead tab id makes `setActiveTab` bounce to tab[0].
    const openTabIds = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
    for (const [tid, s] of Object.entries(storeSnapshot)) {
      if (s.acpSessionId && s.acpSessionId === item.id && openTabIds.has(tid)) {
        setActiveTab(tid);
        return;
      }
    }

    // The agent that actually ran this conversation, from the row — not the
    // tab's current selection. Opening a Codex thread into a Claude tab used
    // to resume it through the wrong process.
    const resumedAgentType = AGENT_TYPE_BY_SIDEBAR[item.agent] ?? item.agent;
    const pluginId = pluginIdForAgent(resumedAgentType);
    // The thread's OWN directory. A row from another worktree resumes into the
    // worktree it belongs to, which is the point of listing it here at all.
    const threadCwd = item.cwd || cwd;

    // Decide the target tab. If the current tab is mid-flight the agent is
    // still streaming into it, so open a new tab rather than overwrite.
    const currentRunning = isBusyAgentStatus(storeSnapshot[tabId]?.status);
    const targetTabId = currentRunning
      ? `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      : tabId;

    if (currentRunning) {
      addTab({
        id: targetTabId,
        type: "chat",
        title: item.title.slice(0, 40) || "Chat",
        closable: true,
        dirty: false,
        data: {},
      });
      createSession(targetTabId, resumedAgentType);
      setActiveTab(targetTabId);
    }

    clearSession(targetTabId);
    setSessionAgentType(targetTabId, resumedAgentType);
    setSessionTitle(targetTabId, item.title.slice(0, 40));
    const cachedAgent = getAgentSync(pluginId);
    if (cachedAgent && item.id) {
      // Optimistic: the backend has not loaded it yet, so flag the window so a
      // send queues rather than firing at a session the manager lacks.
      setAcpBinding(targetTabId, cachedAgent.agent_id, item.id, threadCwd);
    }
    setResumePending(targetTabId, true);
    setTranscriptLoading(targetTabId, true);

    // Click-token cancellation: each click bumps the token for this tab, so
    // rapid clicks collapse instead of piling up in-flight resumes.
    const myToken = bumpLoadToken(targetTabId);
    const isStale = () => isLoadStale(targetTabId, myToken);

    void (async () => {
      await Promise.resolve();
      if (isStale()) return;

      let resumed;
      try {
        resumed = await resumeThreadFast({
          threadId: item.threadId,
          cwd: threadCwd,
          sessionId: item.id || null,
          cb: {
            paint: (msgs) => replaceMessages(targetTabId, msgs),
            onPainted: () => setTranscriptLoading(targetTabId, false),
            isStale,
          },
        });
      } catch (err) {
        if (isStale()) return;
        setResumePending(targetTabId, false);
        setTranscriptLoading(targetTabId, false);
        const stage = err instanceof ResumeError ? err.stage : "resume";
        const msg = err instanceof Error ? err.message : String(err);
        if (stage === "snapshot") {
          // The session IS open — only reading it back failed. Leave the bind.
          toast.error(`Couldn't load session: ${msg}`);
        } else {
          // Roll the optimistic binding back: leaving `acpSessionId` pointing
          // at a session the backend never opened strands the tab, because the
          // chat panel's bind effect early-returns when a binding exists. True
          // whether the agent failed to start or failed to reopen — one call
          // did both, and neither left a session behind. The history row is
          // untouched: only the user deletes rows.
          console.warn("resume failed:", err);
          clearSession(targetTabId);
          toast.error(`Couldn't resume this session: ${msg.slice(0, 120)}`);
        }
        return;
      }
      if (isStale()) return;

      const { key, snapshot } = resumed;
      setAcpBinding(targetTabId, key.agent_id, key.session_id, threadCwd);
      setResumePending(targetTabId, false);
      if (resumed.resumedWithoutHistory) {
        // Honest rather than mysterious: this agent can continue the
        // conversation but cannot replay it, so the thread opens empty.
        toast.info("This agent can't replay past messages — the conversation continues from here.");
      }
      hydrateSessionSnapshot(targetTabId, snapshot.status, snapshot.plan);
      setAcpModes(
        targetTabId,
        snapshot.current_mode,
        snapshot.available_modes,
        agentTypeFromPluginId(snapshot.plugin_id),
      );
      if (snapshot.available_models.length > 0) {
        setAcpModels(targetTabId, snapshot.current_model, snapshot.available_models);
      }
      setAcpAvailableCommands(targetTabId, snapshot.available_commands ?? []);
      // The knobs travel the same way (#32): the resume snapshot is the only
      // carrier for an agent that never volunteers a notification. Tagged with
      // the snapshot's own agent so a stale binding can't seed another
      // agent's pill or cache (#36).
      setAcpConfigOptions(
        targetTabId,
        snapshot.config_options ?? [],
        agentTypeFromPluginId(snapshot.plugin_id),
      );
      setTranscriptLoading(targetTabId, false);
    })();
  };

  const handleArchiveAgent = async (e: React.MouseEvent, item: SidebarItem) => {
    e.stopPropagation();
    try {
      // Out of the way, not gone. The thread stays in History and comes back
      // the moment it is opened (ADR-0001: archive is a shelf, not a grave).
      await archiveThread(item.threadId);
    } catch (err) {
      toast.error(`Couldn't archive: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeleteAgent = async (e: React.MouseEvent, item: SidebarItem) => {
    e.stopPropagation();
    try {
      // One call for every agent. Atlas's own row goes first and always; the
      // agent is asked to forget its copy only if it advertised that it can
      // (ADR-0001). No per-agent branch, and no path into anyone's storage.
      await deleteThread(item.threadId);
      if (activeAcpId === item.id) clearSession(tabId);
      // The workspace panel's "Chats" list is a separate persisted store,
      // recorded on agent activity and never re-validated — purge the deleted
      // session's row so it doesn't linger there.
      useRecentChatsStore.getState().actions.removeBySession(item.id);
    } catch (err) {
      console.error("Failed to delete session:", err);
      toast.error(`Couldn't delete session: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // --- Resize handle ---
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeStartXRef = useRef<number | null>(null);
  const resizeStartWidthRef = useRef<number>(0);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // Guard against a second drag starting before the first's mouseup
      // cleanup runs (e.g. rapid double-mousedown) — that would stack two
      // `mousemove` listeners and move the handle double-distance per pixel.
      if (resizeStartXRef.current !== null) return;
      resizeStartXRef.current = e.clientX;
      resizeStartWidthRef.current = chatSidebar.width;
      const onMove = (ev: MouseEvent) => {
        if (resizeStartXRef.current === null) return;
        const delta = ev.clientX - resizeStartXRef.current;
        setChatSidebarWidth(resizeStartWidthRef.current + delta);
      };
      const onUp = () => {
        resizeStartXRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatSidebar.width, setChatSidebarWidth],
  );

  if (!asDropdown && !chatSidebar.visible) {
    return null;
  }

  const isActiveItem = (item: SidebarItem) => {
    if (item.kind === "agent") {
      // Match the active tab by the SAME id formula `items` uses for live
      // rows: bound acpSessionId, else the synthetic `live-<tabId>`. Without
      // the fallback a focused live-only session (e.g. Codex, or any chat
      // before it binds) never highlights.
      const activeId = activeAcpId ?? `live-${tabId}`;
      return item.id === activeId;
    }
    return item.id === tabId;
  };

  const showEmpty = !isLoading && filtered.length === 0;

  return (
    <div
      ref={containerRef}
      style={asDropdown ? undefined : { width: chatSidebar.width }}
      className={cn(
        "relative flex flex-col",
        asDropdown
          ? "h-[min(420px,60vh)] w-[340px]"
          : "shrink-0 h-full border-r border-[var(--border-default)] bg-[var(--bg-sidebar)]",
      )}
    >
      {/* Search — full-width row matching the GitHub panel's search */}
      <div
        className={cn(
          "flex items-center gap-1.5 h-[32px] shrink-0 px-3",
          // The dropdown sits on a blurred, translucent panel — an opaque fill
          // here would punch a solid rectangle through the blur.
          asDropdown ? "border-b border-white/5" : "border-b border-border-default bg-bg-primary",
        )}
      >
        <Search size={11} className="text-text-tertiary shrink-0" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search sessions"
          placeholder="Search…"
          className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary min-w-0"
        />
        {/* Everything ever, archived included — and where import lives. */}
        {!asDropdown && (
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            aria-label="All history"
            title="All history — archived threads, and import"
            className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            <History size={11} />
          </button>
        )}
      </div>
      <ThreadHistoryView
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onOpenThread={(thread) => handleOpenAgent(itemFromThread(thread, thread.projectName, cwd))}
      />

      {/* List */}
      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {isLoading && (
          <div className="text-[11px] text-[var(--text-tertiary)] px-3 py-2">Loading…</div>
        )}
        {showEmpty && (
          <div className="text-[11px] text-[var(--text-tertiary)] px-3 py-3 leading-relaxed">
            {search.trim() ? "No sessions match your search." : "No chats yet."}
          </div>
        )}
        {filtered.map((item, idx) => {
          const active = isActiveItem(item);
          const isRunning = runningKeys.has(`${item.kind}:${item.id}`);
          const isLast = idx === filtered.length - 1;
          return (
            <div key={item.threadId}>
              {item.projectHeading && (
                // The project a run of rows belongs to. Threads from other
                // worktrees are listed here too, and resume into their own
                // worktree — that is what an app-level store is for.
                <div className="px-3 pt-2.5 pb-1 text-[9px] uppercase tracking-wider text-text-tertiary truncate">
                  {item.projectHeading}
                </div>
              )}
              <div
                onClick={() => {
                  if (item.kind !== "agent") return;
                  handleOpenAgent(item);
                  // Dismiss the picker; the sidebar variant stays put.
                  onOpened?.();
                }}
                className={cn(
                  "group relative w-full text-left px-3 py-3 transition-colors flex flex-col gap-1 cursor-pointer select-none",
                  active
                    ? "bg-[var(--bg-selected)] text-[var(--text-primary)] opacity-100"
                    : "text-[var(--text-secondary)] opacity-80 hover:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                  !isLast && "border-b border-[var(--border-default)]",
                )}
              >
                <div className="flex items-start gap-2 min-w-0 pr-5">
                  <span
                    className="shrink-0 inline-flex h-[15px] items-center justify-center text-[var(--text-secondary)]"
                    title={
                      item.kind !== "agent"
                        ? "AI Chat"
                        : agentMeta(AGENT_TYPE_BY_SIDEBAR[item.agent] ?? item.agent).label
                    }
                  >
                    {isRunning ? (
                      <AtlasLoader size={8} className="text-[var(--accent-primary)]" />
                    ) : item.kind === "agent" ? (
                      item.agent === "codex" ? (
                        <CodexIcon className="size-3" />
                      ) : item.agent === "opencode" ? (
                        <OpenCodeIcon className="size-3" />
                      ) : item.agent === "cursor" ? (
                        <CursorIcon className="size-3" />
                      ) : item.agent === "kilo" ? (
                        <KiloIcon className="size-3" />
                      ) : item.agent === "cersei" ? (
                        <AtlasIcon size={12} />
                      ) : item.agent === "claude" ? (
                        <ClaudeIcon className="size-3" />
                      ) : agentMeta(item.agent).iconDataUrl ? (
                        <ExternalAgentIcon dataUrl={agentMeta(item.agent).iconDataUrl!} size={12} />
                      ) : (
                        <AgentMonogram label={agentMeta(item.agent).label} size={12} />
                      )
                    ) : (
                      <MessageSquare size={11} className="text-[var(--accent-primary)]" />
                    )}
                  </span>
                  <span className="text-[11px] leading-snug line-clamp-2 flex-1">{item.title}</span>
                </div>
                <div className="pl-[18px] flex items-center gap-1.5">
                  <span className="text-[9px] text-[var(--text-tertiary)]">
                    {timeAgo(item.lastUpdated, { suffix: true })}
                  </span>
                  {item.elsewhere && (
                    <span
                      className="text-[9px] text-[var(--text-tertiary)] truncate"
                      title={item.cwd}
                    >
                      · {item.projectName}
                    </span>
                  )}
                </div>

                {/* Both work for every agent now: the row is Atlas's, so neither
                  depends on reaching the agent that produced it. */}
                <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={(e) => handleArchiveAgent(e, item)}
                    aria-label="Archive session"
                    className="flex items-center justify-center w-4 h-4 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                    title="Archive — keeps it in History"
                  >
                    <Archive size={10} />
                  </button>
                  <button
                    onClick={(e) => handleDeleteAgent(e, item)}
                    aria-label="Delete session"
                    className="flex items-center justify-center w-4 h-4 rounded text-[var(--text-tertiary)] hover:text-[var(--status-error)] hover:bg-[var(--bg-elevated)]"
                    title="Delete session"
                  >
                    <X size={10} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom mini-bar. Height matches the left panel's collapsed Git
          strip (a 28px button + its 1px top border = 29px) so this
          footer's top border lines up horizontally with the Git strip's. */}
      <div
        className={cn(
          "flex items-center justify-between px-1.5 h-[29px]",
          // Same rule as the search row above: an opaque fill would punch a
          // solid strip through the picker's blurred panel.
          asDropdown
            ? "border-t border-white/5"
            : "border-t border-[var(--border-default)] bg-[var(--bg-sidebar)]",
        )}
      >
        <button
          onClick={toggleChatSidebar}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="Hide sidebar (⌘⌥J)"
        >
          <PanelLeft size={12} />
        </button>
        <button
          onClick={handleNewChat}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="New chat"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Resize handle — subtle, matches main panel handles. The dropdown has
          its own fixed size, so it has nothing to resize. */}
      {!asDropdown && (
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 -right-px w-px h-full bg-border-default hover:bg-accent transition-colors cursor-col-resize"
          title="Drag to resize"
        />
      )}
    </div>
  );
});
