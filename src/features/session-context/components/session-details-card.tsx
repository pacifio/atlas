// The session Details card: one card over the session's top-right, shown and
// hidden by its title-bar button (`session-details-button.tsx`).
//
// It merged two cards that said the same things twice (the session overview
// and the session context card), so each fact is here once:
//
//   Workspace        open in an editor, project scripts
//   Projects         the folders the session works in
//   Version control  branch, pull requests, the git action
//   Changes          every file the session changed
//   Lineage          the session it branched from, its branches, its child agents
//   Memory           what it remembered
//   Session          agent and model, usage, capture; the project; its actions
//
// Showing it is a toggle and nothing else. It never takes layout space from
// the transcript or the composer: docked, it is drawn into room the panel
// keeps at its top-right whether or not it shows (`context-dock.ts`); where
// there is no such room it is a popover under its button. Either way it is
// capped at the height above the composer, sheds its least useful sections
// before it scrolls (`session-overview-layout.ts`), and scrolls inside itself
// after.
//
// Contract with the transcript: opening the card or folding a section must
// not re-render a single transcript row. Nothing here writes to the chat
// store, and the card's own state lives in `session-details-store`.

import { useLayoutEffect, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { CapturePopover } from "@/features/capture/components/capture-popover";
import { UsagePopup } from "@/features/chat/components/usage-popup";
import {
  UNMEASURED,
  resolveOverviewDensity,
  type OverviewDensity,
  type OverviewHeights,
} from "@/features/chat/lib/session-overview-layout";
import { useSessionUsage } from "@/features/chat/lib/use-session-usage";
import { cn } from "@/lib/utils";

import { useDetailsProjectPath } from "../lib/details-project-path";
import { useSessionWorkPath } from "../lib/session-work-path";
import { useCaptureState, type CaptureState } from "../lib/use-capture-state";
import { useSessionDetailsStore } from "../stores/session-details-store";
import { ChangesSection } from "./changes-section";
import { LineageSection } from "./lineage-section";
import { MemorySection } from "./memory-section";
import { ProjectsSection } from "./projects-section";
import { SessionSection } from "./session-section";
import { VersionControlSection } from "./version-control-section";
import { WorkspaceSection } from "./workspace-section";

export type DetailsPresentation = "docked" | "popover";

/** Slack for subpixel rounding, so a card measured to fit exactly is not
 *  stepped down by half a pixel. */
const MEASURE_SLACK = 1;

/**
 * The card, in either form. `maxHeight` is the room above the composer (the
 * caller measures it); the density steps and the internal scroll both work
 * inside it, so the card can never reach the composer.
 */
export function SessionDetailsCard({
  tabId,
  onOpenSearch,
  presentation,
  maxHeight,
}: {
  tabId: string;
  /** Opens the session's find bar: the Session section's search button. */
  onOpenSearch?: () => void;
  presentation: DetailsPresentation;
  /** `null` while unmeasured: the card shows in full under its CSS cap. */
  maxHeight: number | null;
}) {
  const projectPath = useDetailsProjectPath(tabId);
  const capture = useCaptureState(projectPath);
  const view = useSessionDetailsStore.use.view();
  // Which sections are folded changes every step's height, so it is part of
  // what a measurement is valid for. Without it, a card that stepped down to
  // `essential` (which is never measured) would stay there after the reader
  // folded the section that pushed it.
  const collapsedKey = useSessionDetailsStore((s) => Object.keys(s.collapsed).sort().join(","));
  const key = `${tabId}:${presentation}:${view}:${collapsedKey}`;
  const [measured, setMeasured] = useState<{ key: string; heights: OverviewHeights }>({
    key,
    heights: UNMEASURED,
  });
  const heights = measured.key === key ? measured.heights : UNMEASURED;
  // A drill-in view is one surface: it scrolls rather than sheds.
  const density: OverviewDensity =
    maxHeight === null || view !== "main" ? "full" : resolveOverviewDensity(maxHeight, heights);

  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!content || density === "essential" || view !== "main") return;
    const measure = () => {
      const frame = content.parentElement;
      // The content's own height plus the frame's border: what the card would
      // need to show this step without scrolling.
      const chrome = frame ? frame.offsetHeight - frame.clientHeight : 0;
      const next = Math.max(1, content.offsetHeight + chrome - MEASURE_SLACK);
      setMeasured((current) => {
        const base = current.key === key ? current.heights : UNMEASURED;
        return current.key === key && base[density] === next
          ? current
          : { key, heights: { ...base, [density]: next } };
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [content, density, key, view]);

  return (
    <div
      aria-label="Session details"
      role="region"
      data-session-details-card={presentation}
      data-density={density}
      style={maxHeight === null ? undefined : { maxHeight }}
      className={cn(
        "hide-scrollbar flex min-h-0 flex-col overflow-y-auto overscroll-contain",
        "rounded-lg border border-border bg-popover text-foreground shadow-md",
        // The capture view keeps the 352px its radar is laid out against. It
        // is a drill-in, so docked its extra width overlaps the clearance (and
        // at most a sliver of the column) only while it is open.
        view === "capture" ? "w-[352px]" : "w-[300px]",
      )}
    >
      {/* Whichever section comes first (the steps shed from the top) draws
          no rule over itself: the card's border is its edge. */}
      <div ref={setContent} className="flex flex-col [&>section:first-child]:border-t-0">
        <DetailsBody
          tabId={tabId}
          projectPath={projectPath}
          capture={capture}
          density={density}
          onOpenSearch={onOpenSearch}
        />
      </div>
    </div>
  );
}

function DetailsBody({
  tabId,
  projectPath,
  capture,
  density,
  onOpenSearch,
}: {
  tabId: string;
  projectPath: string | null;
  capture: CaptureState;
  density: OverviewDensity;
  onOpenSearch?: () => void;
}) {
  const view = useSessionDetailsStore.use.view();
  // A pull request session works in a worktree, not the project's checkout:
  // the rows that act on files act there.
  const workPath = useSessionWorkPath(tabId, projectPath) ?? projectPath;
  if (view === "capture" && projectPath) {
    return (
      <DrillIn title="Session capture">
        <CapturePopover
          embedded
          projectPath={projectPath}
          health={capture.health}
          onChanged={capture.refresh}
          onClose={() => useSessionDetailsStore.getState().actions.back()}
        />
      </DrillIn>
    );
  }
  if (view === "usage") {
    return (
      <DrillIn title="Usage">
        <UsageView tabId={tabId} />
      </DrillIn>
    );
  }
  const full = density === "full";
  const essential = density === "essential";
  return (
    <>
      {/* Shed first, as the card runs short of height: the project-wide rows
          (where it runs, which folders), then the version control rows and
          the Session section. The session's own record (what it changed,
          delegated and remembered) always stays. */}
      {!essential && projectPath && (
        <WorkspaceSection projectPath={projectPath} workPath={workPath ?? projectPath} />
      )}
      {full && projectPath && <ProjectsSection tabId={tabId} projectPath={projectPath} />}
      {!essential && projectPath && (
        <VersionControlSection
          tabId={tabId}
          projectPath={projectPath}
          workPath={workPath ?? projectPath}
        />
      )}
      <ChangesSection tabId={tabId} projectPath={projectPath} />
      <LineageSection tabId={tabId} projectPath={projectPath} />
      <MemorySection tabId={tabId} projectPath={projectPath} />
      {!essential && (
        <SessionSection
          tabId={tabId}
          capture={capture}
          projectPath={projectPath}
          onOpenSearch={onOpenSearch}
          showProject={full}
        />
      )}
    </>
  );
}

/** Mounted only while shown, so the usage record is fetched only then. */
function UsageView({ tabId }: { tabId: string }) {
  const view = useSessionUsage(tabId, true);
  return <UsagePopup view={view} />;
}

/** A drill-in view: a back row, then the surface. */
function DrillIn({ title, children }: { title: string; children: ReactNode }) {
  const back = useSessionDetailsStore.use.actions().back;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-1.5">
        <button
          type="button"
          onClick={back}
          className="flex h-7 cursor-pointer items-center gap-1 rounded-lg px-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover"
        >
          <ChevronLeft size={14} aria-hidden />
          Back
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-xs font-medium text-secondary-foreground">
          {title}
        </span>
        {/* Balances the back button so the title centres on the card. */}
        <span className="w-14 shrink-0" aria-hidden />
      </div>
      {children}
    </div>
  );
}
