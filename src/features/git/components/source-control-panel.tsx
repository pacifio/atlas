import { lazy, Suspense } from "react";
import { GitCommit, GitCompare } from "lucide-react";
import { cn } from "@/lib/utils";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { GithubIcon } from "@/components/github-icon";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { Button } from "@tryatlas/design";

// All three sections are lazy so none of them runs its first invokes or vendor
// parses before the tab is opened. `GitManagerPanel` in particular pulls in
// `@tanstack/react-virtual` and parses git diff text that can be large on
// active branches.
const GitManagerPanel = lazy(() =>
  import("./git-manager/git-manager-panel").then((m) => ({ default: m.GitManagerPanel })),
);
// xyflow + the layout pass are heavy; load only when the section is opened.
const GitGraphPanel = lazy(() =>
  import("./git-graph-panel").then((m) => ({ default: m.GitGraphPanel })),
);
const GithubPanel = lazy(() =>
  import("@/features/github/components/github-panel").then((m) => ({ default: m.GithubPanel })),
);

const SECTIONS = [
  { id: "changes" as const, label: "Changes", icon: GitCompare },
  { id: "git-graph" as const, label: "Commit", icon: GitCommit },
  { id: "github" as const, label: "GitHub", icon: GithubIcon },
];

/**
 * The source-control surface: Changes, Commit (the graph) and GitHub, picked
 * from a row inside the tab, since the column's own header is its tab strip.
 * The section is kept in the layout store so reopening the tab lands where it
 * was left.
 */
export function SourceControlPanel() {
  const section = useLayoutStore.use.sourceControl().section;
  const { setSourceControlSection } = useLayoutStore.use.actions();

  return (
    <div className="flex h-full flex-col bg-card">
      {/* A size container: the inactive sections drop to icons when the
          column is too narrow for every label. */}
      <div className="@container flex h-control-lg shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border-subtle px-1.5 hide-scrollbar">
        {SECTIONS.map((s) => {
          const active = section === s.id;
          return (
            <Button
              key={s.id}
              variant="ghost"
              size="sm"
              onClick={() => setSourceControlSection(s.id)}
              title={s.label}
              aria-pressed={active}
            >
              <s.icon size={14} />
              <span className={cn(!active && "hidden @[18rem]:inline")}>{s.label}</span>
            </Button>
          );
        })}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1",
          // The graph owns its scrolling (ReactFlow); the others scroll vertically.
          section === "git-graph" ? "overflow-hidden" : "overflow-auto hide-scrollbar",
        )}
      >
        <Suspense
          fallback={
            <PanelSkeleton label={section === "changes" ? "Loading changes…" : "Loading…"} />
          }
        >
          {section === "changes" && <GitManagerPanel />}
          {section === "git-graph" && <GitGraphPanel />}
          {section === "github" && <GithubPanel />}
        </Suspense>
      </div>
    </div>
  );
}
