import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { Fragment, memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Search, PanelLeft, Plus, History } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { isBusyAgentStatus, agentTypeFromPluginId } from "@/types/agent";
import { pluginIdForAgent } from "@/types/agent";
import { repoPullRequestsKey } from "@/features/git/lib/git-pr-api";
import { ThreadHistoryView } from "./thread-history-view";
import { SessionCard } from "./session-card";
import { placeProjectNames } from "../lib/sidebar-grouping";
import { useAppStore } from "@/features/app/stores/app-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { useOrgStore } from "@/features/organisations/stores/org-store";
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
import { useRecentChatsStore } from "@/features/projects/stores/recent-chats-store";
import { resumeThreadFast, ResumeError } from "../lib/resume-session";
import { applyModeOnResume, holdUnrestoredMode } from "../lib/resume-mode";
import { AGENT_TYPE_BY_SIDEBAR, sidebarAgentOf, type SidebarAgent } from "../lib/sidebar-agents";

/** The message of a failed query, for the error row. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One key for the whole sidebar: history is one store, so there is one query. */
const THREAD_PROJECTS_KEY = ["thread-projects"] as const;

/** One history row, as the list renders it. Used by the sidebar's own list and
 *  by the history view handing a row back to be opened — one builder, so the
 *  two cannot disagree about what a row is. */
function itemFromThread(thread: ThreadRow, projectName: string, elsewhere = false): SidebarItem {
  return {
    // Never a draft: `threads_projects` lists only threads that have been sent
    // to, so the session id is always there.
    id: thread.sessionId ?? "",
    threadId: thread.threadId,
    kind: "agent",
    title: thread.title,
    projectName,
    elsewhere,
    lastUpdated: thread.updatedAt,
    agent: sidebarAgentOf(thread.agentId),
    // The thread's own directory — where it resumes.
    cwd: thread.folderPaths[0] ?? "",
    branch: thread.branch ?? null,
  };
}

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
  /** The project this thread belongs to. Named on the card only when it is
   *  `elsewhere`, and as a heading when no project is open. */
  projectName: string;
  /** The thread belongs to a project other than the open one. From the
   *  project's own `isCurrent`, not a path compare here: the stored paths are
   *  canonicalised and the UI's `cwd` is not, so comparing them directly
   *  marked every row "elsewhere" the moment the two spellings diverged. */
  elsewhere: boolean;
  /** The thread's own working directory — where it resumes, which is not
   *  necessarily the project that happens to be open. */
  cwd: string;
  /** The branch the thread ran on, as it recorded it. */
  branch: string | null;
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
  const sidebarHint = useActionShortcut("panels.agentSidebar")?.label;
  const asDropdown = variant === "dropdown";
  const queryClient = useQueryClient();
  const project = useAppStore.use.currentProject();
  // `currentProject` is a legacy field that's transiently null during boot and
  // project switches (it's repopulated by a fire-and-forget `void switchTo`).
  // When it's null, `cwd` was "" → every history query (gated on
  // `cwd.length > 0`) returned [] → the sidebar showed only ephemeral live rows.
  // Fall back to the active project's path (the real source of truth).
  const activeProjectId = useProjectStore.use.activeProjectId();
  // ACTIVE-org projects only — the fallback below must never resolve to (or
  // hold, via the sticky ref) a path that belongs to another organisation.
  // (`projects` further down is the thread-history grouping, not this list.)
  const orgProjects = useActiveOrgProjects();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const resolvedCwd =
    project?.path ?? orgProjects.find((w) => w.id === activeProjectId)?.path ?? "";
  // STICKY cwd. It no longer keys any query — history is one app-level store —
  // but it still decides which project's threads sort to the top and which
  // directory a resumed thread binds against, and both would flicker if it
  // collapsed to "" for a render. Even with the project fallback,
  // `currentProject` and
  // `activeProjectId`/`orgProjects` can momentarily DISAGREE mid-switch,
  // collapsing `resolvedCwd` to "" for a render or two. Hold the last NON-EMPTY
  // cwd across those blips; only clear it when there is genuinely no project
  // open (zero projects).
  const lastCwdRef = useRef("");
  // The sticky hold must not survive an ORG switch — it would pin the
  // outgoing org's cwd (and thus its thread ordering) into the new org while
  // teardown has everything transiently null. Reset it the moment the org
  // changes, render-synchronously.
  const lastOrgRef = useRef(activeOrganisationId);
  if (lastOrgRef.current !== activeOrganisationId) {
    lastOrgRef.current = activeOrganisationId;
    lastCwdRef.current = "";
  }
  if (resolvedCwd) {
    lastCwdRef.current = resolvedCwd;
  } else if (orgProjects.length === 0) {
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
  // directory, Codex's SQLite, Kilo's SQLite, the old native store, Atlas's
  // transcripts and a live ACP `session/list`, merged by session id. That
  // coupled the sidebar to four private storage formats and meant an agent
  // nobody had written a reader for had no history at all (ADR-0001).
  //
  // No polling and no file watching: the store says when it changed.
  const {
    data: projects = [],
    isLoading,
    isError: historyFailed,
    error: historyError,
    isSuccess: historyReady,
  } = useQuery({
    queryKey: [...THREAD_PROJECTS_KEY, cwd],
    queryFn: () => threadProjects(cwd),
    staleTime: 30_000,
    refetchInterval: false,
    placeholderData: keepPreviousData,
    // A history store that failed to open fails the same way on a retry; say
    // so at once instead of spinning "Loading…" through three attempts.
    retry: false,
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

  // The open project's threads, newest first. `threads_projects` is scoped to
  // `cwd`, so this is normally a single group and needs no ordering of its own
  // — Rust already sorted by recency. The flatMap still handles several groups
  // because the unscoped case (no project open) returns them all.
  const items = useMemo<SidebarItem[]>(
    () =>
      projects.flatMap((project) =>
        project.threads.map((thread) => itemFromThread(thread, project.name, !project.isCurrent)),
      ),
    [projects],
  );

  // Self-heal the project panel's persisted "Chats" list for THIS project.
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

  // Sessions currently busy (the card's live status, and the tab whose turn
  // its timer reads).
  // Keys MUST match the `id`s used when constructing `items` above, otherwise
  // the spinner never lights up. Once an agent session is bound we key by
  // `acpSessionId`; while it's still spawning we use the synthetic
  // `live-${tabId}` placeholder.
  const liveByKey = useMemo(() => {
    const map = new Map<string, { status: "running" | "waiting"; tabId: string }>();
    for (const [tid, s] of Object.entries(tabSummaries)) {
      if (!isBusyAgentStatus(s.status)) continue;
      const liveId = s.acpSessionId ?? `live-${s.id}`;
      map.set(`agent:${liveId}`, {
        status: s.status === "waiting" ? "waiting" : "running",
        tabId: tid,
      });
    }
    return map;
  }, [tabSummaries]);

  // A turn that just ended may have pushed a branch or opened a PR: refresh
  // that repository's pull requests, the one query every card in it shares.
  const busyDirsRef = useRef(new Map<string, string>());
  useEffect(() => {
    const busyNow = new Map<string, string>();
    for (const [tid, s] of Object.entries(tabSummaries)) {
      if (isBusyAgentStatus(s.status)) busyNow.set(tid, s.workingDirectory);
    }
    for (const [tid, dir] of busyDirsRef.current) {
      if (!busyNow.has(tid) && dir) {
        void queryClient.invalidateQueries({ queryKey: repoPullRequestsKey(dir) });
      }
    }
    busyDirsRef.current = busyNow;
  }, [tabSummaries, queryClient]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? items.filter((it) => it.title.toLowerCase().includes(q)) : items;
  }, [items, search]);

  // Where each row's project is named (`placeProjectNames`): on the card for a
  // row from another project, as headings when no project is open — Rust then
  // marks nothing current and returns every project.
  const placements = useMemo(
    () => placeProjectNames(filtered, !projects.some((project) => project.isCurrent)),
    [filtered, projects],
  );

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
          // The session IS open — only reading it back failed. Leave the bind,
          // and since the mode was never applied, hold sends until a pick.
          holdUnrestoredMode(targetTabId);
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
      // Before the send gate opens. `setResumePending(false)` is what releases
      // a queued prompt, so a mode applied after it can lose the race and the
      // first turn runs under the engine's default instead of the user's pick.
      // The session/new path guards the same race the same way.
      await applyModeOnResume(targetTabId, key, snapshot);
      if (isStale()) return;
      setResumePending(targetTabId, false);
      if (resumed.resumedWithoutHistory) {
        // Honest rather than mysterious. Any messages on screen came from
        // Atlas's own transcript, so the user can still read the conversation —
        // but the AGENT was handed none of it and won't refer back to it.
        toast.info("This agent can't replay past messages — it won't remember what's above.");
      }
      hydrateSessionSnapshot(targetTabId, snapshot.status, snapshot.plan);
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

  const handleArchiveAgent = async (item: SidebarItem) => {
    try {
      // Out of the way, not gone. The thread stays in History and comes back
      // the moment it is opened (ADR-0001: archive is a shelf, not a grave).
      await archiveThread(item.threadId);
    } catch (err) {
      toast.error(`Couldn't archive: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeleteAgent = async (item: SidebarItem) => {
    try {
      // One call for every agent. Atlas's own row goes first and always; the
      // agent is asked to forget its copy only if it advertised that it can
      // (ADR-0001). No per-agent branch, and no path into anyone's storage.
      await deleteThread(item.threadId);
      if (activeAcpId === item.id) clearSession(tabId);
      // The project panel's "Chats" list is a separate persisted store,
      // recorded on agent activity and never re-validated — purge the deleted
      // session's row so it doesn't linger there.
      useRecentChatsStore.getState().actions.removeBySession(item.id);
    } catch (err) {
      console.error("Failed to delete session:", err);
      toast.error(`Couldn't delete session: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Stable per-card handlers, so the memoised cards do not all re-render with
  // the list. They look the row up by thread id and call the latest handler
  // through a ref (the handlers close over this render's cwd and tab).
  const itemsByThreadRef = useRef(new Map<string, SidebarItem>());
  itemsByThreadRef.current = new Map(items.map((it) => [it.threadId, it]));
  const handlersRef = useRef({
    open: handleOpenAgent,
    archive: handleArchiveAgent,
    remove: handleDeleteAgent,
    onOpened,
  });
  handlersRef.current = {
    open: handleOpenAgent,
    archive: handleArchiveAgent,
    remove: handleDeleteAgent,
    onOpened,
  };
  const onOpenCard = useCallback((threadId: string) => {
    const item = itemsByThreadRef.current.get(threadId);
    if (!item) return;
    handlersRef.current.open(item);
    // Dismiss the picker; the sidebar variant stays put.
    handlersRef.current.onOpened?.();
  }, []);
  const onArchiveCard = useCallback((threadId: string) => {
    const item = itemsByThreadRef.current.get(threadId);
    if (item) void handlersRef.current.archive(item);
  }, []);
  const onDeleteCard = useCallback((threadId: string) => {
    const item = itemsByThreadRef.current.get(threadId);
    if (item) void handlersRef.current.remove(item);
  }, []);

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

  // An error is not an empty list: a history store that failed to open says so.
  const showError = historyFailed && projects.length === 0;
  const showEmpty = !isLoading && !showError && filtered.length === 0;

  return (
    <div
      ref={containerRef}
      style={asDropdown ? undefined : { width: chatSidebar.width }}
      className={cn(
        "relative flex flex-col",
        asDropdown
          ? "h-[min(420px,60vh)] w-[340px]"
          : "shrink-0 h-full border-r border-[var(--border)] bg-[var(--sidebar)]",
      )}
    >
      {/* Search — full-width row matching the GitHub panel's search */}
      <div
        className={cn(
          "flex items-center gap-1.5 h-[32px] shrink-0 px-3",
          // The dropdown sits on a blurred, translucent panel — an opaque fill
          // here would punch a solid rectangle through the blur.
          asDropdown
            ? "border-b border-[var(--atlas-element-hover)]"
            : "border-b border-border bg-background",
        )}
      >
        <Search size={11} className="text-muted-foreground shrink-0" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search sessions"
          placeholder="Search…"
          className="flex-1 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground min-w-0"
        />
        {/* Everything ever, archived included — and where import lives. */}
        {!asDropdown && (
          <Hint label="All history — archived threads, and import">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-label="All history"
              className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer"
            >
              <History size={11} />
            </button>
          </Hint>
        )}
      </div>
      <ThreadHistoryView
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onOpenThread={(thread) => handleOpenAgent(itemFromThread(thread, thread.projectName))}
      />

      {/* List */}
      <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-2 hide-scrollbar">
        {isLoading && <div className="px-1 py-1 text-xs text-muted-foreground">Loading…</div>}
        {showError && (
          <div role="alert" className="px-1 py-1 text-xs leading-relaxed text-error">
            Couldn't load chats: {errorMessage(historyError)}
          </div>
        )}
        {showEmpty && (
          <div className="px-1 py-1 text-xs leading-relaxed text-muted-foreground">
            {/* Names the scope: the list is this project's, so an empty one
                means "nothing here yet", not "no chats anywhere". Other
                projects' chats are behind the History button in the header. */}
            {search.trim() ? "No sessions match your search." : "No chats in this project yet."}
          </div>
        )}
        {filtered.map((item, index) => {
          const live = liveByKey.get(`${item.kind}:${item.id}`);
          const { heading, showProject } = placements[index]!;
          const card = (
            <SessionCard
              key={item.threadId}
              threadId={item.threadId}
              title={item.title}
              projectName={item.projectName}
              showProject={showProject}
              branch={item.branch}
              cwd={item.cwd}
              lastUpdated={item.lastUpdated}
              status={live?.status ?? null}
              liveTabId={live?.tabId ?? null}
              active={isActiveItem(item)}
              agent={item.agent}
              onOpen={onOpenCard}
              onArchive={onArchiveCard}
              onDelete={onDeleteCard}
            />
          );
          if (!heading) return card;
          return (
            <Fragment key={item.threadId}>
              <div
                role="heading"
                aria-level={3}
                className={cn(
                  "-mx-2 truncate px-3 pt-1.5 pb-0.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground",
                  // Sticky in the sidebar, where the list sits on the opaque
                  // sidebar fill; the dropdown's panel is translucent and
                  // blurred, and a sticky fill there would punch through it.
                  !asDropdown && "sticky top-0 z-panel bg-[var(--sidebar)]",
                )}
              >
                {heading}
              </div>
              {card}
            </Fragment>
          );
        })}
      </div>

      {/* Bottom mini-bar. Height matches the left panel's collapsed Git
          strip (a 28px button + its 1px top border = 29px) so this
          footer's top border lines up horizontally with the Git strip's. */}
      <HintGroup side="top">
        <div
          className={cn(
            "flex items-center justify-between px-1.5 h-[29px]",
            // Same rule as the search row above: an opaque fill would punch a
            // solid strip through the picker's blurred panel.
            asDropdown
              ? "border-t border-[var(--atlas-element-hover)]"
              : "border-t border-[var(--border)] bg-[var(--sidebar)]",
          )}
        >
          <HintItem label={sidebarHint ? `Hide sidebar (${sidebarHint})` : "Hide sidebar"}>
            <button
              onClick={toggleChatSidebar}
              className="flex items-center justify-center w-6 h-6 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)] transition-colors cursor-pointer"
            >
              <PanelLeft size={12} />
            </button>
          </HintItem>
          <HintItem label="New chat">
            <button
              onClick={handleNewChat}
              className="flex items-center justify-center w-6 h-6 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)] transition-colors cursor-pointer"
            >
              <Plus size={12} />
            </button>
          </HintItem>
        </div>
      </HintGroup>

      {/* Resize handle — subtle, matches main panel handles. The dropdown has
          its own fixed size, so it has nothing to resize. */}
      {!asDropdown && (
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 -right-px w-px h-full bg-border hover:bg-primary transition-colors cursor-col-resize"
          title="Drag to resize"
        />
      )}
    </div>
  );
});
