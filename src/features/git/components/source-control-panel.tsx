import { lazy, Suspense } from "react";
import { GitCompare, History } from "lucide-react";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { GithubIcon } from "@/components/brand-marks";
import { useLayoutStore, type SourceControlSection } from "@/features/layout/stores/layout-store";
import { Segmented, type SegmentedOption } from "@tryatlas/design";
import { useGitStore } from "../stores/git-store";

// Both halves are lazy so neither runs its first invokes or vendor parses
// before the tab is opened. `GitManagerPanel` pulls in
// `@tanstack/react-virtual` and parses git diff text that can be large on
// active branches.
const GitManagerPanel = lazy(() =>
  import("./git-manager/git-manager-panel").then((m) => ({ default: m.GitManagerPanel })),
);
const GithubPanel = lazy(() =>
  import("@/features/github/components/github-panel").then((m) => ({ default: m.GithubPanel })),
);

/**
 * The source-control surface: Changes, History (the commit graph) and GitHub,
 * picked from one segmented control — the pull request viewer's — since the
 * column's own header is its tab strip. Changes and History share the branch
 * bar under it; GitHub (reference clones) is about other repositories, so it
 * has none.
 *
 * The section ids are the persisted ones (`git-graph` is History), so a saved
 * layout and the UI actions that name a section keep working.
 */
export function SourceControlPanel() {
  const section = useLayoutStore.use.sourceControl().section;
  const { setSourceControlSection } = useLayoutStore.use.actions();
  const changed = useGitStore((s) => s.files.length);

  const options: SegmentedOption<SourceControlSection>[] = [
    {
      value: "changes",
      label: "Changes",
      icon: <GitCompare size={12} />,
      count: changed > 0 ? changed : undefined,
    },
    { value: "git-graph", label: "History", icon: <History size={12} /> },
    { value: "github", label: "GitHub", icon: <GithubIcon size={12} /> },
  ];

  return (
    <div className="flex h-full flex-col bg-card">
      <nav
        aria-label="Source control sections"
        className="flex shrink-0 items-center border-b border-border-subtle px-2 py-1.5"
      >
        <Segmented
          aria-label="Source control section"
          size="sm"
          value={section}
          onValueChange={setSourceControlSection}
          options={options}
        />
      </nav>

      <div
        className={
          section === "github" ? "min-h-0 flex-1 overflow-auto hide-scrollbar" : "min-h-0 flex-1"
        }
      >
        <Suspense
          fallback={
            <PanelSkeleton label={section === "changes" ? "Loading changes…" : "Loading…"} />
          }
        >
          {section === "github" ? (
            <GithubPanel />
          ) : (
            <GitManagerPanel view={section === "changes" ? "changes" : "history"} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
