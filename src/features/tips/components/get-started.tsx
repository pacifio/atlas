import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/features/app/stores/app-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useCommandPaletteStore } from "@/features/command-palette/stores/command-palette-store";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { requestModelPicker } from "@/features/chat/lib/model-picker-events";
import { openCapture } from "@/features/capture/lib/open-capture";
import { useProjectFacts } from "@/features/capture/lib/project-facts";
import { useTipsStore } from "../stores/tips-store";
import { IconButton } from "@tryatlas/design";

/**
 * Get started (CONTEXT.md): three steps from an empty install to the first
 * checkpoint, in the sidebar above its footer. Each item does its step when
 * clicked, and ticks itself when the real thing happens — never a "mark done"
 * box. Open until the first step is done, then a single row that expands.
 *
 * Shown to a fresh install, and to someone who upgraded only while they have
 * no project — the rest already know the way. Closing it is for good, unless
 * Replay all tips brings it back unfinished.
 *
 * DRAFT COPY.
 */

const ITEMS = ["add-project", "run-session", "checkpoint"] as const;
type Item = (typeof ITEMS)[number];

/** How long the fresh session's composer gets to mount before its picker is
 *  asked for. */
const PICKER_DELAY_MS = 300;

export function GetStarted() {
  const done = useTipsStore.use.checklist();
  const dismissed = useTipsStore.use.checklistDismissed();
  const skipped = useTipsStore.use.getStartedSkipped();
  const hasProject = useProjectStore((s) => s.projects.length > 0);
  const projectPath = useAppStore((s) => s.currentProject?.path ?? null);
  const capturing = useProjectFacts(projectPath)?.binding?.enabled ?? false;
  const [expanded, setExpanded] = useState<boolean | null>(null);

  const count = ITEMS.filter((i) => done.includes(i)).length;
  if (skipped !== false || dismissed || count === ITEMS.length) return null;
  // Open until the first step lands; after that, the user's choice.
  const open = expanded ?? count === 0;

  const rows: Record<Item, { title: string; detail: string; run?: () => void }> = {
    "add-project": {
      title: "Add a project",
      detail: "A folder, a Git URL or a GitHub repository.",
      run: () => useCommandPaletteStore.getState().actions.openAddProject(),
    },
    "run-session": {
      title: "Run a session with an agent",
      detail: "Pick an agent, or install Claude Code or Codex in one click.",
      run: hasProject
        ? () => {
            const tabId = openNewAgentChat();
            window.setTimeout(() => requestModelPicker(tabId), PICKER_DELAY_MS);
          }
        : undefined,
    },
    checkpoint: {
      title: "See your first checkpoint",
      detail: capturing
        ? "Commit the agent's work, and Atlas links it to the session."
        : "Turn on session capture so the session is kept.",
      run: projectPath && !capturing ? openCapture : undefined,
    },
  };

  return (
    <section aria-label="Get started" className="mx-2 mb-2 rounded-md border border-border bg-card">
      <div className="flex items-center gap-1 py-1 pl-2.5 pr-1">
        <button
          type="button"
          onClick={() => setExpanded(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs font-medium text-foreground"
        >
          Get started
          <span className="text-muted-foreground">
            · {count}/{ITEMS.length}
          </span>
          {open ? (
            <ChevronUp className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 text-muted-foreground" />
          )}
        </button>
        <IconButton
          icon={X}
          label="Close Get started"
          size="sm"
          onClick={() => void useTipsStore.getState().actions.dismissChecklist()}
        />
      </div>
      {open && (
        <ol className="flex flex-col gap-0.5 px-1 pb-1.5">
          {ITEMS.map((item) => {
            const row = rows[item];
            const isDone = done.includes(item);
            const actionable = !isDone && row.run !== undefined;
            return (
              <li key={item}>
                <button
                  type="button"
                  disabled={!actionable}
                  onClick={row.run}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left",
                    actionable && "cursor-pointer hover:bg-element-hover",
                  )}
                >
                  {isDone ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                  ) : (
                    <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-xs",
                        isDone ? "text-muted-foreground line-through" : "text-foreground",
                      )}
                    >
                      {row.title}
                    </span>
                    {!isDone && (
                      <span className="block text-2xs text-muted-foreground">{row.detail}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
