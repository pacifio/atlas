// Container for the Activity tab: the shared event log shaped into session
// groups (`lib/memory-activity.ts`), filtered, with each line able to open
// the memory it became and each session able to open on the Timeline. The
// markup is `./views/memory-activity-view.tsx`.

import { useMemo, useState } from "react";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { useMemoryStore } from "../stores/memory-store";
import { agentMetaForSource } from "../lib/memory-agent";
import { buildActivity } from "../lib/memory-activity";
import { openMemorySession } from "../lib/open-memory-session";
import { MemoryActivityView } from "./views/memory-activity-view";

export function MemoryActivity() {
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
      agentFilter={agentFilter}
      agentOptions={agentOptions}
      formatAgent={(a) => agentMetaForSource(a).label}
      onAgentFilterChange={setAgentFilter}
      onOpenEntry={focusEntry}
      onOpenSession={(group) => {
        if (!projectPath || !group.sessionId) return;
        openMemorySession({ projectPath, sessionId: group.sessionId });
      }}
    />
  );
}
