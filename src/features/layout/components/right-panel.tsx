import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { GitCommit, GitCompare } from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { Hint } from "@/ui/tooltip";

// All three right-panel sub-panels are lazy so they don't run their first
// invokes / vendor parses during the boot-cascade window. The user lands
// on a project, sees the tab bar + skeleton instantly, and the data slides
// in as each chunk + IPC resolves. `GitManagerPanel` in particular pulls in
// `@tanstack/react-virtual` and parses git diff text that can be large on
// active branches — keeping it lazy stops the right panel from blocking
// the post-`hydrate` render.
const GitManagerPanel = lazy(() =>
  import("@/features/git/components/git-manager/git-manager-panel").then((m) => ({
    default: m.GitManagerPanel,
  })),
);
// xyflow + the layout pass are heavy; load only when the user opens the tab.
const GitGraphPanel = lazy(() =>
  import("@/features/git/components/git-graph-panel").then((m) => ({
    default: m.GitGraphPanel,
  })),
);
const GithubPanel = lazy(() =>
  import("@/features/github/components/github-panel").then((m) => ({
    default: m.GithubPanel,
  })),
);
// Team chat shares the right slot with source control — ⌘⇧C claims it, ⌘⇧B
// claims it back. Lazy for the same reason as the panels above: it is never on
// screen during the boot cascade unless the slot was left on chat.
const CommsPanel = lazy(() =>
  import("@/features/comms/components/comms-panel").then((m) => ({
    default: m.CommsPanel,
  })),
);
const sections = [
  {
    id: "changes" as const,
    label: "Source Control",
    name: "Source Control",
    hint: "Source Control — Review changes and create commits",
    icon: GitCompare,
  },
  {
    id: "git-graph" as const,
    label: "Commit",
    name: "Git Graph / Commit History",
    hint: "Git Graph / Commit History — Explore branches and commits",
    icon: GitCommit,
  },
  {
    id: "github" as const,
    label: "GitHub",
    name: "GitHub",
    hint: "GitHub — Browse pull requests and issues",
    icon: GithubIcon,
  },
];

export function RightPanel() {
  const rightPanel = useLayoutStore.use.rightPanel();
  const activeSection = rightPanel.activeSection;
  const { setRightSection } = useLayoutStore.use.actions();

  if (rightPanel.mode === "chat") {
    return (
      <Suspense fallback={<PanelSkeleton label="Chat" />}>
        <CommsPanel />
      </Suspense>
    );
  }

  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[var(--card)]">
      <div className="flex items-center border-b border-border px-1 h-[29px] shrink-0 gap-0.5 overflow-x-auto hide-scrollbar">
        {sections.map((s) => (
          <Hint key={s.id} label={s.hint}>
            <button
              aria-label={s.name}
              aria-pressed={activeSection === s.id}
              onClick={() => setRightSection(s.id)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer shrink-0 whitespace-nowrap",
                activeSection === s.id
                  ? "text-foreground bg-element-selected"
                  : "text-muted-foreground hover:text-secondary-foreground hover:bg-element-hover",
              )}
            >
              <s.icon size={12} aria-hidden />
              {s.label}
            </button>
          </Hint>
        ))}
      </div>

      <div
        className={cn(
          "flex-1 min-h-0",
          // Git Graph owns its own scrolling (via ReactFlow); other panels scroll vertically.
          activeSection === "git-graph" ? "overflow-hidden" : "overflow-auto hide-scrollbar",
        )}
      >
        <Suspense
          fallback={
            <PanelSkeleton label={activeSection === "changes" ? "Loading changes…" : "Loading…"} />
          }
        >
          {activeSection === "changes" && <GitManagerPanel />}
          {activeSection === "git-graph" && <GitGraphPanel />}
          {activeSection === "github" && <GithubPanel />}
        </Suspense>
      </div>
    </div>
  );
}
