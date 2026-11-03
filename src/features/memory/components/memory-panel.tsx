import { useTipOnMount } from "@/features/tips/lib/use-tip-on-mount";
import { useState } from "react";
import { Share2, SlidersHorizontal } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { chainBroken, healthLine, useMemoryHealth } from "../lib/use-memory-health";
import { MemoryGraphView } from "./memory-graph-view";
import { MemoryPolicyView } from "./memory-policy-view";
import { MemorySharingControls } from "./memory-sharing-controls";
import { SharedMemoryView } from "./shared-memory-view";
import { useAppStore } from "@/features/app/stores/app-store";
import { useMemoryStore } from "../stores/memory-store";

// ── Panel shell ─────────────────────────────────────────────────────────────
//
// Three views over the project's memory: the semantic Graph, the retrieval
// Policy, and Shared memory. Each loads its own data on mount / project change
// and owns its own refresh, so the shell is just navigation.
//
// Three things used to live here and were removed:
//   * **Chat** (2026-08-22) — an on-device RAG chat over the memory index.
//   * **The coding-agent dropdown** (2026-08-22) — per-agent memory browsers
//     (Claude Code, Codex, Atlas, and every capture-backed agent). It
//     enumerated agents from three different sources and drifted out of step
//     with the ACP registry rework, listing duplicates. Rebuilding it belongs
//     on the registry, not on the hand-rolled agent list it was built against.
//   * **Timeline** (2026-09-22) — a branch-aware board of git commits, agent
//     sessions and the memory each one touched. Never used; it also carried
//     the module's heaviest backend call (`memory_timeline` walked every ref
//     and re-collected the corpus on each project visit). Removed whole, down
//     to the Rust command — the session Timeline in the center panel is a
//     different, unrelated feature and is untouched.

export function MemoryPanel() {
  useTipOnMount("memory");
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  const sub = useMemoryStore.use.subTab();
  const { setSubTab } = useMemoryStore.use.actions();

  return (
    <div className="h-full flex flex-col bg-[var(--background)]">
      {/* Header: nav (left) · sharing controls (right) */}
      <div className="flex items-center h-[32px] shrink-0 border-b border-[var(--border)] px-2">
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
            active={sub === "shared"}
            onClick={() => setSubTab("shared")}
            icon={<Share2 size={12} />}
            label="Shared"
          />
        </PillGroup>

        <div className="ml-auto flex items-center gap-1">
          <MemoryHealthLine projectPath={projectPath} />
          <MemorySharingControls projectPath={projectPath} />
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {sub === "graph" ? (
          <MemoryGraphView />
        ) : sub === "policy" ? (
          <MemoryPolicyView />
        ) : projectPath ? (
          <SharedMemoryView projectPath={projectPath} />
        ) : (
          <Centered>
            <p className="text-sm text-[var(--muted-foreground)]">
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
    <div className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--card,var(--card))] p-0.5">
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
        "flex items-center gap-1.5 h-control-xs px-2.5 rounded-full text-xs font-medium outline-none transition-colors cursor-pointer",
        active
          ? "bg-[var(--atlas-element-selected)] text-[var(--foreground)]"
          : "text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)]",
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

/** What the memory reconciler's last pass found, in one muted line; when the
 *  history was edited outside Atlas, the one way to trust it again. */
function MemoryHealthLine({ projectPath }: { projectPath: string | null }) {
  const status = useMemoryHealth(projectPath);
  const [confirm, setConfirm] = useState(false);
  const line = healthLine(status);
  if (!line || !projectPath) return null;
  const accept = async () => {
    setConfirm(false);
    try {
      await invoke<boolean>("memory_accept_history", { projectPath });
      toast.success("Memory history accepted");
    } catch (err) {
      toast.error(`Couldn't accept: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <span className="flex items-center gap-1.5 text-2xs text-[var(--muted-foreground)]">
      {line}
      {chainBroken(status) && (
        <>
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className="underline underline-offset-2 hover:text-[var(--foreground)]"
          >
            I made this edit
          </button>
          <FileTreeConfirmDelete
            open={confirm}
            name="memory history"
            isDir={false}
            title="Trust the edited memory history?"
            body="Memories whose history was changed outside Atlas will be trusted again and served to every agent as they now read. If you did not make this edit, restore yesterday's snapshot instead."
            confirmLabel="Trust it"
            onConfirm={() => void accept()}
            onOpenChange={setConfirm}
          />
        </>
      )}
    </span>
  );
}
