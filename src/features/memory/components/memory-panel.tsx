import { GitBranch, Share2, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { MemoryGraphView } from "./memory-graph-view";
import { MemoryPolicyView } from "./memory-policy-view";
import { MemoryTimelineView } from "./memory-timeline-view";
import { MemorySharingControls } from "./memory-sharing-controls";
import { SharedMemoryView } from "./shared-memory-view";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useMemoryStore } from "../stores/memory-store";

// ── Panel shell ─────────────────────────────────────────────────────────────
//
// Four views over the project's memory: the semantic Graph, the retrieval
// Policy, the Timeline, and Shared memory. Each loads its own data on mount /
// project change and owns its own refresh, so the shell is just navigation.
//
// Two things used to live here and were removed on 2026-08-22:
//   * **Chat** — an on-device RAG chat over the memory index.
//   * **The coding-agent dropdown** — per-agent memory browsers (Claude Code,
//     Codex, Atlas, and every capture-backed agent). It enumerated agents from
//     three different sources and drifted out of step with the ACP registry
//     rework, listing duplicates. Rebuilding it belongs on the registry, not on
//     the hand-rolled agent list it was built against.

export function MemoryPanel() {
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
  const sub = useMemoryStore.use.subTab();
  const { setSubTab } = useMemoryStore.use.actions();

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      {/* Header: nav (left) · sharing controls (right) */}
      <div className="flex items-center h-[32px] shrink-0 border-b border-[var(--border-default)] px-2">
        <PillGroup>
          <PillSeg
            active={sub === "graph"}
            onClick={() => setSubTab("graph")}
            icon={<Share2 size={12} />}
            label="Graph"
          />
          <PillSeg
            active={sub === "policy"}
            onClick={() => setSubTab("policy")}
            icon={<SlidersHorizontal size={12} />}
            label="Policy"
          />
          <PillSeg
            active={sub === "timeline"}
            onClick={() => setSubTab("timeline")}
            icon={<GitBranch size={12} />}
            label="Timeline"
          />
          <PillSeg
            active={sub === "shared"}
            onClick={() => setSubTab("shared")}
            icon={<Share2 size={12} />}
            label="Shared"
          />
        </PillGroup>

        <div className="ml-auto flex items-center gap-1">
          <MemorySharingControls projectPath={projectPath} />
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {sub === "graph" ? (
          <MemoryGraphView />
        ) : sub === "policy" ? (
          <MemoryPolicyView />
        ) : sub === "timeline" ? (
          <MemoryTimelineView />
        ) : projectPath ? (
          <SharedMemoryView projectPath={projectPath} />
        ) : (
          <Centered>
            <p className="text-[12px] text-[var(--text-tertiary)]">
              Open a project to view shared memory.
            </p>
          </Centered>
        )}
      </div>
    </div>
  );
}

/** Rounded container that groups the segmented nav pills. */
function PillGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated,var(--bg-secondary))] p-0.5">
      {children}
    </div>
  );
}

function PillSeg({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 h-[22px] px-2.5 rounded-full text-[11px] font-medium outline-none transition-colors cursor-pointer",
        active
          ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center">{children}</div>;
}
