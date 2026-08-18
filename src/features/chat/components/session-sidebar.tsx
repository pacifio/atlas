import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { X, MessageSquare, Search, PanelLeft, Plus } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { stripInjectedContext } from "@/features/chat/lib/atlas-context";
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
import { useProjectStore } from "@/features/project/stores/project-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { bumpLoadToken, isLoadStale } from "../lib/load-tokens";
import {
  listClaudeSessions,
  listCodexSessions,
  listCerseiSessions,
  listKiloSessions,
  deleteClaudeSession,
  cerseiDeleteSession,
  codexDeleteSession,
  kiloDeleteSession,
  type ClaudeSessionMeta,
} from "../lib/claude-api";
import { ensureAgent, getAgentSync } from "../lib/agents-api";
import { AtlasIcon } from "@/components/atlas-icon";
import { useRecentChatsStore } from "@/features/workspaces/stores/recent-chats-store";
import { resumeSessionFast, ResumeError } from "../lib/resume-session";

/** Short per-row agent tag. "claude" doubles as the legacy default for rows
 *  with no metadata, so the mapping from AgentType is centralised here instead
 *  of repeated ternaries that silently mislabel new agents. */
type SidebarAgent = "claude" | "codex" | "opencode" | "cursor" | "kilo" | "cersei" | (string & {});

function sidebarAgentOf(agentType: string | undefined): SidebarAgent {
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

const AGENT_TYPE_BY_SIDEBAR: Partial<Record<string, SwitchableAgent>> = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor",
  kilo: "kilo",
  cersei: "cersei",
};

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M". */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

interface SidebarItem {
  id: string; // acpSessionId for agent rows, tabId for chat rows
  kind: "agent" | "chat";
  title: string;
  subtitle: string | null;
  lastUpdated: string | null;
  messageCount: number;
  /** Which coding agent ran this session (drives the row icon). Defaults to
   *  "claude" — historical Claude-only sessions + anything without metadata. */
  agent: SidebarAgent;
  // agent-only
  filePath?: string;
  /** Cumulative tokens processed (native Atlas agent sessions only). */
  totalTokens?: number;
  // chat-only
  tabId?: string;
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
   * This is a variant rather than a second component on purpose. Building the
   * list means merging live tabs with three agents' on-disk listings and
   * suppressing twins, and OPENING a row is ~180 lines of resume logic with
   * several hard-won edge cases (orphan tabs, Codex rows with no JSONL, stale
   * clicks). Duplicating either would guarantee they drift.
   */
  variant?: "sidebar" | "dropdown";
  /** Called after a row is opened — lets the picker close itself. */
  onOpened?: () => void;
}

// memo: ChatPanel re-renders once per streaming rAF flush (whole-session
// subscription), and this 1000-line body — four useQuery hooks + the history
// merge — re-executed with it every frame. Props are stable from ChatPanel
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
  // STICKY cwd. Even with the workspace fallback, `currentProject` and
  // `activeWorkspaceId`/`workspaces` can momentarily DISAGREE mid-switch (e.g.
  // when opening a Codex/Cersei session or hitting "+"), collapsing `resolvedCwd`
  // to "" for a render or two. Because the three history queries are keyed on
  // cwd, that blip flipped the keys to an empty/uncached entry → all lists
  // flashed to [] and the whole history vanished until the next refetch (the
  // "disappears, then comes back later" the user saw). Hold the last NON-EMPTY
  // cwd so the query keys stay stable across these blips; only clear it when
  // there is genuinely no project open (zero workspaces).
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

  const queryKey = ["claude-sessions", cwd] as const;

  // Polling-free listing. The Rust-side watcher (started below) emits
  // `atlas:sessions-changed` whenever the project's JSONL directory mutates,
  // so we refetch on event rather than every 1.5–5s. The cost of the disk
  // walk only pays off when something actually changed.
  const {
    data: agentList = [],
    isLoading,
    isSuccess: agentReady,
    isPlaceholderData: agentPlaceholder,
  } = useQuery({
    queryKey,
    queryFn: () => listClaudeSessions(cwd),
    enabled: cwd.length > 0,
    staleTime: 30_000,
    refetchInterval: false,
    // Keep the prior rows on screen while the key changes or a refetch runs,
    // instead of flashing to the empty default. Belt-and-braces with the sticky
    // cwd above — together they guarantee history never blinks out.
    placeholderData: keepPreviousData,
  });

  // Codex sessions live in `~/.codex` (SQLite), NOT Claude's JSONL dir, so they
  // need their own listing — without it past Codex chats vanish from history
  // after a restart. No file watcher exists for the SQLite db, so this refetches
  // on the same focus / `atlas:sessions-changed` triggers as the Claude list.
  const codexQueryKey = ["codex-sessions", cwd] as const;
  const {
    data: codexList = [],
    isSuccess: codexReady,
    isPlaceholderData: codexPlaceholder,
  } = useQuery({
    queryKey: codexQueryKey,
    queryFn: () => listCodexSessions(cwd),
    enabled: cwd.length > 0,
    staleTime: 30_000,
    // Codex (and Cersei) have NO file watcher — the ~/.codex watcher was removed
    // because its SQLite WAL sidecars churn and stormed the refetch loop. So poll
    // every few seconds instead: the read is in-process rusqlite (sub-ms) and
    // keepPreviousData means the poll never flashes the list empty. Without this,
    // a Codex session created after an agent switch only showed on the next window
    // focus ("takes too long; unfocus→focus fixes it").
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  // Native Atlas (Cersei) sessions — persisted as JSON under the app config
  // dir, same merge treatment as Codex.
  const cerseiQueryKey = ["cersei-sessions", cwd] as const;
  const {
    data: cerseiList = [],
    isSuccess: cerseiReady,
    isPlaceholderData: cerseiPlaceholder,
  } = useQuery({
    queryKey: cerseiQueryKey,
    queryFn: () => listCerseiSessions(cwd),
    enabled: cwd.length > 0,
    staleTime: 30_000,
    // No watcher for the Cersei store either — poll (cheap JSON dir read), same
    // rationale as the Codex query above.
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  // Kilo sessions — SQLite at ~/.local/share/kilo/kilo.db, same no-watcher
  // poll + merge treatment as Codex.
  const kiloQueryKey = ["kilo-sessions", cwd] as const;
  const {
    data: kiloList = [],
    isSuccess: kiloReady,
    isPlaceholderData: kiloPlaceholder,
  } = useQuery({
    queryKey: kiloQueryKey,
    queryFn: () => listKiloSessions(cwd),
    enabled: cwd.length > 0,
    staleTime: 30_000,
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  // Start (or replace) the Rust file watcher for this cwd. The single
  // `atlas:sessions-changed` listener below dispatches against `queryKey`
  // closed over the current cwd, so the listener doesn't have to be
  // reattached on every cwd change.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    invoke("sessions_watch_open", { cwd }).catch((err) => {
      if (!cancelled) console.warn("sessions watcher failed to start:", err);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    // Rebuild the key from `cwd` INSIDE the effect. Depending on the
    // `queryKey` array (a fresh literal every render) made this effect
    // re-subscribe on every render; because `listen()` is async, each render
    // opened a teardown→reattach gap where an `atlas:sessions-changed` event
    // could land with no listener attached → the refresh was silently dropped
    // and the history list went stale until something else forced a refetch.
    // Now it attaches once per `cwd` and stays attached.
    const key = ["claude-sessions", cwd] as const;
    const codexKey = ["codex-sessions", cwd] as const;
    const cerseiKey = ["cersei-sessions", cwd] as const;
    const kiloKey = ["kilo-sessions", cwd] as const;
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: codexKey });
      queryClient.invalidateQueries({ queryKey: cerseiKey });
      queryClient.invalidateQueries({ queryKey: kiloKey });
    };
    const unlistenPromise = listen<{ cwd: string }>("atlas:sessions-changed", (e) => {
      if (e.payload.cwd !== cwd) return;
      invalidate();
    });
    window.addEventListener("focus", invalidate);
    return () => {
      unlistenPromise.then((u) => u());
      window.removeEventListener("focus", invalidate);
    };
  }, [queryClient, cwd]);

  // Build the unified item list. Two sources, merged by session id:
  //   1. disk JSONL rows (agentList, from list_claude_sessions polling)
  //   2. live in-store sessions (chat-store, mutated optimistically)
  //
  // We MERGE rather than concat-and-dedup. When both sources have the same id
  // the live row's title wins because the chat-store updates synchronously
  // and is the source of truth for whatever's currently happening; the disk
  // row contributes `filePath` (needed by handleOpenAgent to reload by id)
  // and serves as the fallback `preview` for older sessions that aren't in
  // the live store at all.
  //
  // Net effect: the row's title NEVER flips during the window where a disk
  // row arrives mid-stream — it's always the live `session.title` for as
  // long as the session is in the chat-store.
  const items = useMemo<SidebarItem[]>(() => {
    // Only sessions the user has actually messaged belong in history. A new
    // chat that merely got an ACP session bound (no message yet) must NOT
    // appear — that was the "empty chat I can't remove" bug. The first user
    // message is what promotes a chat into the history list (and becomes its
    // title below).
    // Scope to THIS project: the chat-store is global (it holds every mounted
    // workspace's sessions), so without the cwd filter a session from another
    // open project leaks into this project's history list.
    const liveAgents = Object.values(tabSummaries).filter(
      (s) =>
        (s.userMessageCount > 0 || s.hasAnyMessage) &&
        (s.workingDirectory === cwd || s.workingDirectory === ""),
    );
    const liveById = new Map(
      liveAgents.map((s) => {
        const id = s.acpSessionId ?? `live-${s.id}`;
        return [id, s] as const;
      }),
    );
    // Merge both agents' disk listings into one map, tagging each row with the
    // agent that produced it so the row icon + resume routing are correct even
    // when there's no live session to infer the agent from. Claude is inserted
    // first; a Codex id never collides with a Claude JSONL id.
    const diskById = new Map<string, { meta: ClaudeSessionMeta; agent: SidebarAgent }>();
    for (const d of agentList) diskById.set(d.id, { meta: d, agent: "claude" });
    for (const d of codexList) diskById.set(d.id, { meta: d, agent: "codex" });
    for (const d of cerseiList) diskById.set(d.id, { meta: d, agent: "cersei" });
    for (const d of kiloList) diskById.set(d.id, { meta: d, agent: "kilo" });

    // An unbound live row (`live-<tabId>` key — after an agent switch or
    // clearSession dropped the binding but kept messages, or during the
    // first-send window before the binding lands) can describe the SAME
    // conversation as a disk row listed under its real session id. Rendering
    // both shows the session twice, so suppress the live twin whenever a
    // disk row already covers the same first-user text.
    const normFirstUser = (t: string) => stripInjectedContext(t).trim().slice(0, 60);
    // Keyed by "<agent>|<text>", paired with the disk row's last-modified
    // time. A live twin is only suppressed when the disk row belongs to the
    // SAME agent and their activity times are close (a true twin's live
    // `updatedAt` tracks its own disk `last_modified`). Cross-agent matches
    // would repaint the chat with the wrong brand icon; distinct same-agent
    // chats that merely share a short opener ("hi") are usually far apart in
    // time, and suppressing those would hide a real conversation.
    const diskPreviews = new Map<string, number>();
    for (const { meta, agent } of diskById.values()) {
      if (meta.preview && meta.preview !== "(no user message)") {
        const p = normFirstUser(meta.preview);
        if (!p) continue;
        const ts = meta.last_modified ? Date.parse(meta.last_modified) : NaN;
        if (Number.isNaN(ts)) continue;
        const key = `${agent}|${p}`;
        const prev = diskPreviews.get(key);
        if (prev === undefined || ts > prev) diskPreviews.set(key, ts);
      }
    }
    const TWIN_WINDOW_MS = 10 * 60 * 1000;
    for (const [id, live] of Array.from(liveById)) {
      if (!id.startsWith("live-")) continue;
      const liveAgent = sidebarAgentOf(live.agentType);
      const first = normFirstUser(live.firstUserContent ?? "");
      if (!first) continue;
      const diskTs = diskPreviews.get(`${liveAgent}|${first}`);
      const liveTs = Date.parse(live.updatedAt ?? "");
      if (
        diskTs !== undefined &&
        !Number.isNaN(liveTs) &&
        Math.abs(liveTs - diskTs) < TWIN_WINDOW_MS
      ) {
        liveById.delete(id);
      }
    }

    const allIds = new Set<string>([...liveById.keys(), ...diskById.keys()]);

    const agents: SidebarItem[] = Array.from(allIds, (id) => {
      const live = liveById.get(id);
      const diskEntry = diskById.get(id);
      const disk = diskEntry?.meta;
      // Strip Atlas-injected memory scaffolding before deriving the title/preview
      // (resumed sessions echo the injected prompt). A dirty fragment cleans to "".
      const firstUser = stripInjectedContext(live?.firstUserContent ?? "");
      const liveTitle = stripInjectedContext(live?.title ?? "");
      const diskPreview =
        disk?.preview && disk.preview !== "(no user message)"
          ? stripInjectedContext(disk.preview)
          : "";
      const title =
        (liveTitle && liveTitle !== "New Chat" ? liveTitle : "") ||
        firstUser.slice(0, 80) ||
        diskPreview ||
        liveTitle ||
        "New session";
      const lastUpdated =
        live?.status === "running"
          ? (live.updatedAt ?? disk?.last_modified ?? null)
          : (disk?.last_modified ?? live?.updatedAt ?? null);
      return {
        id,
        kind: "agent" as const,
        title,
        subtitle: null,
        lastUpdated,
        // Show a row if EITHER the live session OR the on-disk record has
        // content. A live session that reports userMessageCount=0 (just-bound or
        // resumed, counter not caught up) must NOT shadow a disk row that
        // genuinely has messages — that hid real sessions from history (frontend
        // `items: 0` while `claude: 4`). Take the max of the two signals.
        messageCount: Math.max(
          live
            ? live.userMessageCount > 0
              ? live.userMessageCount
              : live.hasAnyMessage
                ? 1
                : 0
            : 0,
          disk?.message_count ?? 0,
        ),
        // Agent identity: prefer the live session's, else the agent that
        // produced the disk row (Claude JSONL vs Codex rollout). Drives the
        // row icon AND which agent process handleOpenAgent resumes through.
        agent: live ? sidebarAgentOf(live.agentType) : (diskEntry?.agent ?? "claude"),
        filePath: disk?.file_path,
        totalTokens: disk?.total_tokens,
      };
    });

    // Drop empty rows (disk JSONLs that exist but hold no messages, or any live
    // session that slipped through) so history only ever shows messaged chats.
    return agents
      .filter((a) => a.messageCount > 0)
      .sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""));
  }, [agentList, codexList, cerseiList, kiloList, tabSummaries]);

  // Self-heal the workspace panel's persisted "Chats" list for THIS project.
  // That list (`atlas-recent-chats`) is recorded on agent activity and never
  // re-validated against storage, so rows for sessions deleted elsewhere (or
  // before purge-on-delete existed) linger forever. Once all three disk
  // listings have real (non-placeholder) data, drop any row for this cwd whose
  // session is neither on disk nor live in the chat-store. Placeholder data is
  // excluded so a cwd switch can't purge the new project's rows against the
  // old project's lists.
  useEffect(() => {
    if (!cwd) return;
    if (!agentReady || !codexReady || !cerseiReady || !kiloReady) return;
    if (agentPlaceholder || codexPlaceholder || cerseiPlaceholder || kiloPlaceholder) return;
    const diskIds = new Set<string>([
      ...agentList.map((d) => d.id),
      ...codexList.map((d) => d.id),
      ...cerseiList.map((d) => d.id),
      ...kiloList.map((d) => d.id),
    ]);
    const liveAcp = new Set<string>();
    const liveTabs = new Set<string>();
    for (const s of Object.values(tabSummaries)) {
      if (s.acpSessionId) liveAcp.add(s.acpSessionId);
      liveTabs.add(s.id);
    }
    const { items: recent, actions } = useRecentChatsStore.getState();
    // Grace period: a freshly-active row can be ahead of the polled disk
    // listings (Codex/Cersei refresh on a 4s poll), so judging it against a
    // stale snapshot would purge a real chat. Only rows quiet for a minute
    // are eligible — truly deleted sessions get cleaned on a later pass.
    const cutoff = Date.now() - 60_000;
    for (const c of recent) {
      if (c.projectPath !== cwd) continue;
      if (c.updatedAt > cutoff) continue;
      const alive = c.acpSessionId
        ? diskIds.has(c.acpSessionId) || liveAcp.has(c.acpSessionId)
        : liveTabs.has(c.tabId);
      if (!alive) actions.remove(c.tabId);
    }
  }, [
    cwd,
    agentReady,
    codexReady,
    cerseiReady,
    kiloReady,
    agentPlaceholder,
    codexPlaceholder,
    cerseiPlaceholder,
    kiloPlaceholder,
    agentList,
    codexList,
    cerseiList,
    kiloList,
    tabSummaries,
  ]);

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.title.toLowerCase().includes(q));
  }, [items, search]);

  // Singleton model: "New chat" always starts a fresh session in the CURRENT
  // tab (never a second tab). Shared with ⌘T / the palette / the context menu.
  const handleNewChat = () => openNewAgentChat();

  const handleOpenAgent = (item: SidebarItem) => {
    const storeSnapshot = useChatStore.getState().sessions;

    // Live-focus / de-dup: if an open tab already represents THIS session,
    // just focus it. A tab matches by its bound `acpSessionId` OR by the
    // synthetic `live-<tabId>` id used before binding — the exact same id
    // formula `items` uses to key live rows. Covers re-clicks, clicks while
    // loading, and clicks on a row already open in another tab (incl. a
    // live-only Codex chat that has no disk JSONL to reload from).
    // Only focus a tab that still EXISTS — a closed chat tab leaves its session
    // behind (orphan), and focusing that dead tab id makes `setActiveTab` bounce
    // to tab[0] ("jumps to a different chat"). Skip orphans → reload below.
    const openTabIds = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
    for (const [tid, s] of Object.entries(storeSnapshot)) {
      const liveId = s.acpSessionId ?? `live-${tid}`;
      if (liveId === item.id && openTabIds.has(tid)) {
        setActiveTab(tid);
        return;
      }
    }

    // Past here we reload from disk/ACP, which needs either a JSONL file OR a
    // real (bound) ACP session id. Codex sessions never live in Claude's
    // `~/.claude/projects` JSONL dir, so they only ever arrive as live rows
    // with no `filePath` — gating on `filePath` alone made every Codex history
    // row a dead click. A synthetic `live-<tabId>` with no file is the current
    // empty tab itself (handled above when open), so those still bail here.
    const isSynthetic = item.id.startsWith("live-");
    if (!item.filePath && isSynthetic) return;

    // Pick the agent that actually ran this session. This was hardcoded to the
    // default (Claude), so clicking a Codex row tried to resume it through the
    // Claude process → `loadSession` failed → it fell back to a blank session.
    const resumedAgentTypeMapped = AGENT_TYPE_BY_SIDEBAR[item.agent] ?? item.agent;
    const pluginId = pluginIdForAgent(resumedAgentTypeMapped);
    // The composer's agent label must follow the RESUMED session's real agent,
    // not whatever was selected in this tab. Without this, opening (say) an
    // Atlas/Codex session into a Claude-Code tab left the composer on Claude;
    // the user then "switched" agents, which (correctly) spawns a NEW chat —
    // so resuming forced an annoying detour. `item.agent` is already narrowed
    // to a shipped agent, so map it straight to the composer's SwitchableAgent.
    const resumedAgentType = resumedAgentTypeMapped;

    // Decide target tab. If the current tab's session is mid-flight
    // (running OR waiting on the user), we MUST NOT overwrite it — the agent is
    // still streaming back into that session and the user needs to see
    // it keep running. Open the clicked history in a new chat tab
    // instead. Otherwise replace in-place (idle tab is fair game).
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
      // Pre-create the chat-store session before the ChatPanel mounts so
      // the optimistic binding below has something to attach to — with the
      // resumed session's agent so the composer is correct from the first frame.
      createSession(targetTabId, resumedAgentType);
      setActiveTab(targetTabId);
    }

    // Bind with the component's STICKY `cwd` (closed over below), not a fresh
    // `getState().currentProject` read — that can be transiently null at click
    // time, which would stamp the session's `workingDirectory` with "" out of
    // step with the sticky filter and briefly strand the live row.

    // Replacing the CURRENT chat in place (idle tab)? The session we're about to
    // clear loses its live sidebar row. Cersei/Codex have no file watcher, so
    // without a refetch the just-left chat vanishes from history until the user
    // hits "+" (which refreshes). Capture it now → refresh the disk lists below
    // so the abandoned chat re-lists from disk immediately.
    const abandoningCurrent =
      targetTabId === tabId &&
      ((storeSnapshot[tabId]?.userMessageCount ?? 0) > 0 ||
        (storeSnapshot[tabId]?.messages?.length ?? 0) > 0);

    // OPTIMISTIC SYNCHRONOUS UI: clear + retitle + bind the historical
    // session id IMMEDIATELY when the default agent is already cached
    // (App.tsx pre-spawns it at startup, so it almost always is).
    clearSession(targetTabId);
    if (abandoningCurrent) {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: codexQueryKey });
      queryClient.invalidateQueries({ queryKey: cerseiQueryKey });
      queryClient.invalidateQueries({ queryKey: kiloQueryKey });
    }
    // Relabel the composer to the resumed session's agent (no-op if already
    // matching). Keeps the existing binding — does NOT spawn a new chat.
    setSessionAgentType(targetTabId, resumedAgentType);
    setSessionTitle(targetTabId, item.title.slice(0, 40));
    const cachedAgent = getAgentSync(pluginId);
    if (cachedAgent) {
      setAcpBinding(targetTabId, cachedAgent.agent_id, item.id, cwd);
    }
    // The binding above is a GUESS — the backend hasn't loaded this session yet.
    // Flag it so a send during the resume window queues instead of firing at a
    // session the manager doesn't have (the transcript now paints well before
    // the load lands, so this window is user-visible).
    setResumePending(targetTabId, true);
    // Always flag loading at this point — the chat panel renders a spinner
    // instead of the welcome state until the snapshot lands. On a Rust-cache
    // hit the snapshot returns in ~1ms so the spinner is barely visible; on
    // a miss it covers the JSONL replay window.
    setTranscriptLoading(targetTabId, true);

    // Click-token cancellation: each click bumps the token for this tab.
    // Every subsequent await re-checks the token and bails if a newer click
    // has taken over — prevents 5-6 rapid clicks from piling up 5-6 in-flight
    // `loadSession` calls against the same agent.
    const myToken = bumpLoadToken(targetTabId);
    const isStale = () => isLoadStale(targetTabId, myToken);

    void (async () => {
      // Yield once so multiple clicks in the same event-loop tick collapse:
      // every click after this microtask resumes with a stale token and
      // bails before doing any IPC.
      await Promise.resolve();
      if (isStale()) return;

      // Two-stage resume (`resumeSessionFast`): the transcript is read off disk
      // and painted immediately (~50ms even on a 34MB JSONL), while the agent
      // spawn + ACP `session/load` — the part that actually costs seconds — runs
      // concurrently and only gates SENDING, not reading.
      //
      // atlas-agents still owns the cache: `loadSession` is idempotent, so the
      // second visit to the same session is a `DashMap::get` away from instant,
      // with no JSONL replay and no ACP round-trip.
      let agent, snapshot;
      try {
        ({ agent, snapshot } = await resumeSessionFast({
          pluginId,
          sessionId: item.id,
          cwd,
          ensure: () => ensureAgent(pluginId),
          cb: {
            paint: (msgs) => replaceMessages(targetTabId, msgs),
            onPainted: () => setTranscriptLoading(targetTabId, false),
            isStale,
          },
        }));
      } catch (err) {
        // Stale means a NEWER click owns this tab — and it has already set its
        // own `resumePending`. Bail without touching the flag; clearing it here
        // would un-gate the newer resume. Otherwise clear it, so a failed resume
        // never leaves the tab silently queueing every future send.
        if (isStale()) return;
        setResumePending(targetTabId, false);
        const stage = err instanceof ResumeError ? err.stage : "load";
        const msg = err instanceof Error ? err.message : String(err);
        setTranscriptLoading(targetTabId, false);
        if (stage === "spawn") {
          toast.error(`Agent not available: ${msg}`);
        } else if (stage === "load") {
          // Don't silently fork a NEW persisted session here — the clicked file
          // stays on disk and the fork lists as a second history row for what
          // the user experiences as one conversation. Surface the failure and
          // ROLL BACK the optimistic binding set before the load: leaving
          // `acpSessionId` pointing at a session the backend never loaded would
          // block the chat panel's bind effect (it early-returns when a binding
          // exists) and strand the tab. Clearing re-arms the normal new-session
          // flow if the user keeps typing.
          console.warn("loadSession failed:", err);
          clearSession(targetTabId);
          toast.error(`Couldn't resume this session: ${msg.slice(0, 120)}`);
        } else {
          toast.error(`Couldn't load session: ${msg}`);
        }
        return;
      }
      // Same as the catch: a newer click owns the flag, so leave it alone.
      if (isStale()) return;

      setAcpBinding(targetTabId, agent.agent_id, item.id, cwd);
      // Backend now holds the session — sends may go straight through, and the
      // drain effect flushes anything the user queued while resuming.
      setResumePending(targetTabId, false);
      // Restore live status + docked plan AFTER the bind (which clears the
      // plan): switching back to a still-running session re-shows its plan.
      hydrateSessionSnapshot(targetTabId, snapshot.status, snapshot.plan);
      // Seed the composer mode picker from the resumed session's advertised
      // modes (Codex). Claude ignores these in favour of its own pill.
      setAcpModes(
        targetTabId,
        snapshot.current_mode,
        snapshot.available_modes,
        agentTypeFromPluginId(snapshot.plugin_id),
      );
      // Seed the ACP model picker too (Claude Code / Codex). On resume the agent
      // may not re-advertise models, so setAcpModels falls back to the cache.
      if (snapshot.available_models.length > 0) {
        setAcpModels(targetTabId, snapshot.current_model, snapshot.available_models);
      }
      // Seed the slash-command list — resume clears it and `session/load`
      // agents don't reliably re-advertise, so the snapshot is the only
      // source for resumed sessions.
      setAcpAvailableCommands(targetTabId, snapshot.available_commands ?? []);
      setTranscriptLoading(targetTabId, false);
    })();
  };

  const handleDeleteAgent = async (e: React.MouseEvent, item: SidebarItem) => {
    e.stopPropagation();
    try {
      // Route to the agent that actually owns this session's storage. Claude
      // sessions are JSONL files under ~/.claude/projects (deleted by path);
      // Cersei sessions are JSON under the app config dir (deleted by id via
      // its own command — the Claude path guard rejects them); Codex threads
      // live in ~/.codex SQLite and are soft-deleted (archived=1) by id.
      if (item.agent === "cersei") {
        await cerseiDeleteSession(cwd, item.id);
      } else if (item.agent === "codex") {
        await codexDeleteSession(item.id);
      } else if (item.agent === "kilo") {
        // Kilo rows soft-archive in ~/.local/share/kilo/kilo.db by id.
        await kiloDeleteSession(item.id);
      } else if (item.filePath) {
        await deleteClaudeSession(item.filePath);
      } else {
        return;
      }
      if (activeAcpId === item.id) clearSession(tabId);
      // The workspace panel's "Chats" list is a separate persisted store
      // recorded on agent activity and never re-validated against disk —
      // purge the deleted session's row so it doesn't linger there.
      useRecentChatsStore.getState().actions.removeBySession(item.id);
    } catch (err) {
      console.error("Failed to delete session:", err);
      toast.error(`Couldn't delete session: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Always refetch so the list reflects on-disk truth — whether the delete
      // succeeded (row gone) or failed (row stays). All three keys, since a
      // delete shifts the merged/sorted cross-agent view.
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: codexQueryKey });
      queryClient.invalidateQueries({ queryKey: cerseiQueryKey });
      queryClient.invalidateQueries({ queryKey: kiloQueryKey });
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
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto hide-scrollbar">
        {isLoading && (
          <div className="text-[11px] text-[var(--text-tertiary)] px-3 py-2">Loading…</div>
        )}
        {showEmpty && (
          <div className="text-[11px] text-[var(--text-tertiary)] px-3 py-3 leading-relaxed">
            {search.trim()
              ? "No sessions match your search."
              : "No prior sessions for this project."}
          </div>
        )}
        {filtered.map((item, idx) => {
          const active = isActiveItem(item);
          const isRunning = runningKeys.has(`${item.kind}:${item.id}`);
          const isLast = idx === filtered.length - 1;
          return (
            <div
              key={`${item.kind}-${item.id}`}
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
                {!!item.totalTokens && item.totalTokens > 0 && (
                  <span
                    className="text-[9px] text-[var(--text-tertiary)] tabular-nums"
                    title={`${item.totalTokens.toLocaleString()} tokens processed`}
                  >
                    · {formatTokenCount(item.totalTokens)} tok
                  </span>
                )}
              </div>

              {/* Delete supported for all three: Claude removes the JSONL file,
                  Cersei removes its JSON under the app config dir, Codex archives
                  the thread (archived=1) in its ~/.codex SQLite (no file to rm). */}
              {item.kind === "agent" &&
                (item.agent === "cersei" ||
                  item.agent === "codex" ||
                  (item.agent === "claude" && !!item.filePath)) && (
                  <button
                    onClick={(e) => handleDeleteAgent(e, item)}
                    aria-label="Delete session"
                    className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 flex items-center justify-center w-4 h-4 rounded text-[var(--text-tertiary)] hover:text-[var(--status-error)] hover:bg-[var(--bg-elevated)] transition-opacity"
                    title="Delete session"
                  >
                    <X size={10} />
                  </button>
                )}
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
