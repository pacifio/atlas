import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { GitCommit, GitCompare, Github, CheckCheck } from "lucide-react";

// All four right-panel sub-panels are lazy so they don't run their first
// invokes / vendor parses during the boot-cascade window. The user lands
// on a project, sees the tab bar + skeleton instantly, and the data slides
// in as each chunk + IPC resolves. `GitManagerPanel` in particular pulls in
// `@tanstack/react-virtual` and parses git diff text that can be large on
// active branches — keeping it lazy stops the right panel from blocking
// the post-`hydrate` render.
const GitManagerPanel = lazy(() =>
  import("@/features/git/components/git-manager/git-manager-panel").then(
    (m) => ({
      default: m.GitManagerPanel,
    }),
  ),
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
const ReviewAgentsPanel = lazy(() =>
  import("@/features/review-agents/components/review-agents-panel").then(
    (m) => ({
      default: m.ReviewAgentsPanel,
    }),
  ),
);

const sections = [
  { id: "changes" as const, label: "Source Control", icon: GitCompare },
  { id: "review-agents" as const, label: "Review", icon: CheckCheck },
  { id: "git-graph" as const, label: "Commit", icon: GitCommit },
  { id: "github" as const, label: "GitHub", icon: Github },
];

export function RightPanel() {
  const activeSection = useLayoutStore.use.rightPanel().activeSection;
  const { setRightSection } = useLayoutStore.use.actions();

  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[var(--panel-bg-2)]">
      <div className="flex items-center border-b border-border-default px-1 h-[29px] shrink-0 gap-0.5 overflow-x-auto hide-scrollbar">
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setRightSection(s.id)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer shrink-0 whitespace-nowrap",
              activeSection === s.id
                ? "text-text-primary bg-bg-selected"
                : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover",
            )}
          >
            <s.icon size={12} />
            {s.label}
          </button>
        ))}
      </div>

      <div
        className={cn(
          "flex-1 min-h-0",
          // Git Graph owns its own scrolling (via ReactFlow); other panels scroll vertically.
          activeSection === "git-graph"
            ? "overflow-hidden"
            : "overflow-auto hide-scrollbar",
        )}
      >
        <Suspense
          fallback={
            <PanelSkeleton
              label={
                activeSection === "changes" ? "Loading changes…" : "Loading…"
              }
            />
          }
        >
          {activeSection === "review-agents" && <ReviewAgentsPanel />}
          {activeSection === "changes" && <GitManagerPanel />}
          {activeSection === "git-graph" && <GitGraphPanel />}
          {activeSection === "github" && <GithubPanel />}
        </Suspense>
      </div>
    </div>
  );
}
