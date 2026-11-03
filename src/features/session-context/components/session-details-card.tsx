// The session Details card: one card over the session's top-right, shown and
// hidden by its title-bar button (`session-details-button.tsx`).
//
//   Workspace        where it runs, open it in an editor, the project's scripts
//   Version control  branch, pull requests, the git action, what changed
//   Projects         the folders the session works in
//   Lineage          the session it branched from, its branches, its agents
//   Activity         its Bash calls and its plans, as panels
//   (footer)         comments, share, open in the Timeline, find — pinned
//                    under the sections, never scrolled away
//
// Showing it is a toggle and nothing else. It never takes layout space from
// the transcript or the composer: docked, it is drawn into room the panel
// keeps at its top-right whether or not it shows (`context-dock.ts`); where
// there is no such room it is a popover under its button. Either way it is
// capped at the height above the composer, sheds rows it can do without
// before it scrolls (`details-density.ts`), and scrolls inside itself after.
//
// Contract with the transcript: opening the card must not re-render a single
// transcript row. Nothing here writes to the chat store, and the card's own
// state lives in `session-details-store`.

import { useLayoutEffect, useState } from "react";

import { useDetailsProjectPath } from "../lib/details-project-path";
import {
  UNMEASURED,
  resolveDetailsDensity,
  type DetailsDensity,
  type DetailsHeights,
} from "../lib/details-density";
import { useSessionWorkPath } from "../lib/session-work-path";
import { ActivitySection } from "./activity-section";
import { LineageSection } from "./lineage-section";
import { ProjectsSection } from "./projects-section";
import { RemoteControlSection } from "./remote-control-section";
import { VersionControlSection } from "./version-control-section";
import { SessionFooter } from "./session-footer";
import { WorkspaceSection } from "./workspace-section";

export type DetailsPresentation = "docked" | "popover";

/** Slack for subpixel rounding, so a card measured to fit exactly is not
 *  stepped down by half a pixel. */
const MEASURE_SLACK = 1;

/** Lists that grow when asked to, left out of the measure. */
const GROWING_LISTS = "[data-details-pr-list]";

/**
 * The card, in either form. `maxHeight` is the room above the composer (the
 * caller measures it); the density steps and the internal scroll both work
 * inside it, so the card can never reach the composer.
 */
export function SessionDetailsCard({
  tabId,
  presentation,
  maxHeight,
}: {
  tabId: string;
  presentation: DetailsPresentation;
  /** `null` while unmeasured: the card shows in full under its CSS cap. */
  maxHeight: number | null;
}) {
  const projectPath = useDetailsProjectPath(tabId);
  // A pull request session works in a worktree, not the project's checkout:
  // the rows that act on files act there.
  const workPath = useSessionWorkPath(tabId, projectPath) ?? projectPath;
  const key = `${tabId}:${presentation}`;
  const [measured, setMeasured] = useState<{ key: string; heights: DetailsHeights }>({
    key,
    heights: UNMEASURED,
  });
  const heights = measured.key === key ? measured.heights : UNMEASURED;
  const density: DetailsDensity =
    maxHeight === null ? "full" : resolveDetailsDensity(maxHeight, heights);

  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!content || density === "essential") return;
    const measure = () => {
      const scroller = content.parentElement;
      const card = scroller?.parentElement;
      // The content's own height plus everything around the scroller — the
      // card's border and the footer: what the card would need to show this
      // step without scrolling.
      const chrome = scroller && card ? card.offsetHeight - scroller.clientHeight : 0;
      let lists = 0;
      for (const list of content.querySelectorAll<HTMLElement>(GROWING_LISTS)) {
        // The first row of a list counts; what "Show N more" adds does not.
        const first = list.firstElementChild as HTMLElement | null;
        lists += list.offsetHeight - (first?.offsetHeight ?? 0);
      }
      const next = Math.max(1, content.offsetHeight + chrome - lists - MEASURE_SLACK);
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
  }, [content, density, key]);

  return (
    <div
      aria-label="Session details"
      role="region"
      data-session-details-card={presentation}
      data-density={density}
      style={maxHeight === null ? undefined : { maxHeight }}
      // A quiet surface: the popover colour mixed toward the page's (44%), so
      // the card sits on the transcript without a slab of contrast. One line
      // colour for the outline, the section dividers and the footer's rule
      // (`--details-line`): the strong border colour, 40% toward the page.
      // The sections scroll; the footer stays.
      className="flex w-[300px] min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--details-line)] bg-[color-mix(in_srgb,var(--popover)_44%,var(--background))] [--details-line:color-mix(in_srgb,var(--atlas-border-strong)_60%,var(--background))] text-popover-foreground shadow-md"
    >
      <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div ref={setContent} className="flex flex-col">
          {projectPath && workPath ? (
            <>
              <WorkspaceSection
                projectPath={projectPath}
                workPath={workPath}
                showEnvironment={density === "full"}
                showOpenIn={density !== "essential"}
              />
              <VersionControlSection
                tabId={tabId}
                projectPath={projectPath}
                workPath={workPath}
                compact={density !== "full"}
              />
              {density === "full" && <ProjectsSection tabId={tabId} projectPath={projectPath} />}
            </>
          ) : (
            <p className="px-3.5 py-3 text-xs text-muted-foreground">
              This session has no project folder.
            </p>
          )}
          {density === "full" && <LineageSection tabId={tabId} projectPath={projectPath} />}
          <ActivitySection tabId={tabId} presentation={presentation} />
          <RemoteControlSection tabId={tabId} presentation={presentation} />
        </div>
      </div>
      <SessionFooter tabId={tabId} projectPath={projectPath} />
    </div>
  );
}
