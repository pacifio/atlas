import { useTipOnMount } from "@/features/tips/lib/use-tip-on-mount";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Download, FileOutput, FolderInput, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { chainBroken, healthLine, useMemoryHealth } from "../lib/use-memory-health";
import { reviewCount } from "../lib/memory-review-items";
import { MemoryActivity } from "./memory-activity";
import { MemoryAgentFiles } from "./memory-agent-files";
import { MemoryEntries } from "./memory-entries";
import { MemoryReviewQueue } from "./memory-review-queue";
import { MemorySharingControls } from "./memory-sharing-controls";
import { ImportClaudeMemoryModal, ImportRepoModal } from "./shared-memory-modals";
import { Notice } from "./views/memory-chrome";
import { DestinationActions } from "@/features/layout/components/destination-actions";
import { useAppStore } from "@/features/app/stores/app-store";
import { useMemoryStore } from "../stores/memory-store";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Hint,
  IconButton,
  Segmented,
} from "@tryatlas/design";

// ── Panel shell ─────────────────────────────────────────────────────────────
//
// Why a person opens Memory, in order of how often: to see what the agents
// know about this project; to find where something came from ("why does it
// think that?"); to fix or forget what is wrong; to clear what waits for
// review; and, rarely, to control what is shared. The tabs follow that:
//
//   * **Memories**, the front door: the shared record grouped by kind, with
//     the chosen memory's provenance and its fix-or-forget beside it.
//   * **Activity**: how memory changed, session by session, on the history
//     rail (it replaced the raw Events and Plans tables).
//   * **Review**: the queue, one decision at a time.
//   * **Agent files**: the agents' own memory files: Preferences and the Map
//     (tree and graph). The graph used to be the front door; it is a lens.
//
// The destination bar (ADR-0024) carries the nav, the health line, the
// sharing controls and the ⋯ menu (refresh, import, export, clear), so every
// tab shares them. The panel loads the record once per project, so the
// Review count is right before Review is opened.
//
// Removed earlier and not coming back: the on-device RAG chat and the
// per-agent memory browsers (2026-08-22), and the commit/session Timeline
// board (2026-09-22). The session Timeline in the center panel is a
// different feature.

export function MemoryPanel() {
  useTipOnMount("memory");
  const project = useAppStore.use.currentProject();
  const projectPath = project?.path ?? null;
  const projectName = project?.name ?? projectPath?.split("/").pop() ?? "this project";
  const sub = useMemoryStore.use.subTab();
  const { setSubTab } = useMemoryStore.use.actions();
  const review = useSharedMemoryStore.use.review();
  const { load, refresh, clear } = useSharedMemoryStore.use.actions();
  const [importing, setImporting] = useState(false);
  const [importingRepo, setImportingRepo] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const waiting = reviewCount(review);

  useEffect(() => {
    if (projectPath) void load(projectPath);
  }, [projectPath, load]);

  const clearConfirmed = async () => {
    setConfirmClear(false);
    try {
      await clear();
    } catch (err) {
      toast.error(
        `Couldn't clear shared memory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <DestinationActions>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Segmented
            aria-label="Memory view"
            size="sm"
            value={sub}
            onValueChange={(next) => {
              setSubTab(next);
              if (next !== "memories") setSelecting(false);
            }}
            options={[
              { value: "memories", label: "Memories" },
              { value: "activity", label: "Activity" },
              { value: "review", label: "Review", ...(waiting > 0 ? { count: waiting } : {}) },
              { value: "files", label: "Agent files" },
            ]}
          />

          <div className="flex flex-1 items-center justify-end gap-2">
            <MemoryHealthLine projectPath={projectPath} />
            <MemorySharingControls projectPath={projectPath} />
            {projectPath && (
              <MemoryMenu
                onRefresh={() => void refresh()}
                onImportClaude={() => setImporting(true)}
                onImportRepo={() => setImportingRepo(true)}
                onExport={() => {
                  setSubTab("memories");
                  setSelecting(true);
                }}
                onClear={() => setConfirmClear(true)}
              />
            )}
          </div>
        </div>
      </DestinationActions>

      {projectPath && (
        <>
          <ImportClaudeMemoryModal
            open={importing}
            onOpenChange={setImporting}
            onImported={() => setSubTab("memories")}
          />
          <ImportRepoModal
            projectPath={projectPath}
            open={importingRepo}
            onOpenChange={setImportingRepo}
            onImported={() => {
              setSubTab("review");
              void refresh();
            }}
          />
          <FileTreeConfirmDelete
            open={confirmClear}
            name="shared memory"
            isDir={false}
            title="Clear shared memory?"
            body="Every agent on this project loses every plan, decision, fact, failure and architecture note recorded here. This can't be undone."
            confirmLabel="Clear"
            onConfirm={() => void clearConfirmed()}
            onOpenChange={setConfirmClear}
          />
        </>
      )}

      <div className="min-h-0 flex-1">
        {!projectPath ? (
          <Notice title="Open a project">
            Memory is kept per project. Open one to see what agents remember about it.
          </Notice>
        ) : sub === "memories" ? (
          <MemoryEntries
            projectName={projectName}
            selecting={selecting}
            onSelectingChange={setSelecting}
            onImportClaude={() => setImporting(true)}
          />
        ) : sub === "activity" ? (
          <MemoryActivity />
        ) : sub === "review" ? (
          <MemoryReviewQueue />
        ) : (
          <MemoryAgentFiles />
        )}
      </div>
    </div>
  );
}

/** Everything done to the record as a whole, out of the way: refresh (memory
 *  refreshes itself; this is for a runtime that did not say so), the two
 *  imports, the AGENTS.md export, and clearing it. */
function MemoryMenu({
  onRefresh,
  onImportClaude,
  onImportRepo,
  onExport,
  onClear,
}: {
  onRefresh: () => void;
  onImportClaude: () => void;
  onImportRepo: () => void;
  onExport: () => void;
  onClear: () => void;
}) {
  return (
    <DropdownMenu>
      <Hint label="More memory actions">
        <DropdownMenuTrigger
          render={
            <IconButton
              icon={MoreHorizontal}
              label="More memory actions"
              variant="hairline"
              shape="round"
              size="sm"
            />
          }
        />
      </Hint>
      <DropdownMenuContent align="end" side="bottom" className="w-64">
        <DropdownMenuItem onClick={onRefresh}>
          <RefreshCw />
          Refresh
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onImportClaude}>
          <Download />
          Import Claude's memory…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onImportRepo}>
          <FolderInput />
          Import a memory repo…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onExport}>
          <FileOutput />
          Export to AGENTS.md…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onClear}>
          <Trash2 />
          Clear shared memory…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
    // It shares the destination bar with the title and the nav, so the
    // line gives way (truncates) before anything else does. Only the text
    // gives way: its cell has no intrinsic width (`w-0 flex-1`) and takes
    // whatever the bar has left, so this wrapper's minimum is the (unwrapped)
    // button, which then can't overlap the sharing controls.
    <span className="caption flex flex-1 items-center justify-end gap-1.5">
      <span className="flex w-0 flex-1 justify-end">
        {/* Focusable, so the full line is reachable by keyboard once it
            truncates; kept out of window dragging so pressing it can't move
            the window. */}
        <Hint label={line}>
          <span tabIndex={0} role="note" data-no-window-drag className="truncate rounded-sm">
            {line}
          </span>
        </Hint>
      </span>
      {chainBroken(status) && (
        <>
          <button
            type="button"
            onClick={() => setConfirm(true)}
            className="shrink-0 cursor-pointer whitespace-nowrap underline underline-offset-2 transition-colors duration-fast hover:text-foreground"
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
