// The Agent files tab: what coding agents keep in their own files (Claude
// Code's auto-memory and CLAUDE.md, Codex's AGENTS.md and threads, notes),
// indexed by the on-device embedding model. Two lenses over that corpus:
// Preferences, the rules distilled from it and editable in place, and Map,
// the semantic tree and graph with natural-language search.
//
// Both were top-level tabs (Graph was the front door). They answer a narrower
// question than the shared record ("what do the agents' own files say?"),
// share one gate (the model), and are used less, so they sit one level down.

import { Segmented } from "@tryatlas/design";
import { useMemoryStore } from "../stores/memory-store";
import { MemoryGraph } from "./memory-graph";
import { MemoryPolicyView } from "./memory-policy-view";

export function MemoryAgentFiles() {
  const view = useMemoryStore.use.filesView();
  const { setFilesView } = useMemoryStore.use.actions();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5">
        <Segmented
          aria-label="Agent files view"
          size="sm"
          value={view}
          onValueChange={setFilesView}
          options={[
            { value: "preferences", label: "Preferences" },
            { value: "map", label: "Map" },
          ]}
        />
        <p className="min-w-0 truncate text-2xs text-muted-foreground">
          What coding agents keep in their own memory files, indexed on this Mac.
        </p>
      </div>
      <div className="min-h-0 flex-1">
        {view === "preferences" ? <MemoryPolicyView /> : <MemoryGraph />}
      </div>
    </div>
  );
}
