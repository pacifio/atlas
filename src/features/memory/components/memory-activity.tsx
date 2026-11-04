// Container for the Activity tab: the shared event log shaped into session
// groups (`lib/memory-activity.ts`), filtered, with each line able to open
// the memory it became and each session able to open on the Timeline. Each
// line also asks "Why did you learn this?" of the session that wrote it: its
// tab when that session is open, else a new session told where the line came
// from (`lib/memory-ask.ts`). The markup is `./views/memory-activity-view.tsx`.

import { useMemo, useState } from "react";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { useMemoryStore } from "../stores/memory-store";
import { agentMetaForSource } from "../lib/memory-agent";
import { buildActivity } from "../lib/memory-activity";
import { openMemorySession } from "../lib/open-memory-session";
import { activityAsk, MEMORY_ASK_KEYS } from "../lib/memory-ask";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { MemoryActivityView, type WhyAsk } from "./views/memory-activity-view";

/** The open tab of each session that has an agent session id, as
 *  `id=tab` lines: a string, so a streamed token (which changes the store
 *  but not this) does not re-render the tab. */
function useOpenSessionTabs(): Map<string, string> {
  const pairs = useChatStore((s) =>
    Object.entries(s.sessions)
      .filter(([, x]) => x.acpSessionId)
      .map(([tab, x]) => `${x.acpSessionId}=${tab}`)
      .join("\n"),
  );
  const open = useLayoutStore((s) => s.tabs.map((t) => t.id).join("\n"));
  return useMemo(() => {
    const tabs = new Set(open.split("\n"));
    const map = new Map<string, string>();
    for (const pair of pairs ? pairs.split("\n") : []) {
      const at = pair.lastIndexOf("=");
      const tab = pair.slice(at + 1);
      if (tabs.has(tab)) map.set(pair.slice(0, at), tab);
    }
    return map;
  }, [pairs, open]);
}

export function MemoryActivity({
  onAsk,
}: {
  /** The search field's ⌘↵: the typed words, as a memory instruction. */
  onAsk: (text: string, anchor: HTMLElement) => void;
}) {
  const events = useSharedMemoryStore.use.events();
  const entries = useSharedMemoryStore.use.entries();
  const loaded = useSharedMemoryStore.use.loaded();
  const error = useSharedMemoryStore.use.error();
  const projectPath = useSharedMemoryStore.use.projectPath();
  const { load } = useSharedMemoryStore.use.actions();
  const { focusEntry } = useMemoryStore.use.actions();
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("");

  const q = query.trim().toLowerCase();
  const days = useMemo(
    () => buildActivity(events, entries, Date.now(), { query: q, agent: agentFilter }),
    [events, entries, q, agentFilter],
  );
  const sessionTabs = useOpenSessionTabs();
  const whyAsk: WhyAsk = (line, group) =>
    activityAsk(
      line,
      group,
      line.entryId === null ? null : (entries.find((e) => e.id === line.entryId) ?? null),
      projectPath,
      group.sessionId ? (sessionTabs.get(group.sessionId) ?? null) : null,
      agentMetaForSource(group.agent).label,
    );
  const agentOptions = useMemo(
    () => [...new Set(events.map((e) => e.agent).filter(Boolean))].sort(),
    [events],
  );

  return (
    <MemoryActivityView
      loaded={loaded}
      error={error}
      onRetry={() => {
        if (projectPath) void load(projectPath);
      }}
      hasEvents={events.length > 0}
      days={days}
      query={query}
      onQueryChange={setQuery}
      onAsk={onAsk}
      askKeys={MEMORY_ASK_KEYS}
      agentFilter={agentFilter}
      agentOptions={agentOptions}
      formatAgent={(a) => agentMetaForSource(a).label}
      onAgentFilterChange={setAgentFilter}
      onOpenEntry={focusEntry}
      onOpenSession={(group) => {
        if (!projectPath || !group.sessionId) return;
        openMemorySession({ projectPath, sessionId: group.sessionId });
      }}
      whyAsk={whyAsk}
    />
  );
}
