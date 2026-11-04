// The toolbar tray tucked under the composer's input card: the "+" menu, the
// grouped agent / mode / model picker, and the session's pills.

import type { Ref } from "react";
import type { AgentType, SwitchableAgent } from "@/types/agent";
import type { GithubRepo } from "@/features/github/types";
import type { MentionProject, PastSessionRef } from "../lib/mentions";
import { useAppStore } from "@/features/app/stores/app-store";
import { ComposerAddMenu } from "./composer-add-menu";
import { ComposerGroupsMenu } from "./composer-groups-menu";
import { EffortPill } from "./effort-pill";
import { UsagePill } from "./usage-pill";
import { ComposerOptionsPill } from "./composer-options-pill";
import { PlanTasksPill } from "./plan-tasks-pill";

export function ComposerTray({
  tabId,
  agentType,
  switchableAgent,
  trayRef,
  trayShown,
  collapsed,
  disabledProp,
  githubSyncing,
  imageSupported,
  pickFilesOrPhotos,
  pickMedia,
  handleTakeScreenshot,
  handleCloneRepo,
  handlePickSession,
  handlePickProject,
  handleSwitchAgent,
}: {
  tabId: string;
  agentType: AgentType;
  switchableAgent: SwitchableAgent;
  trayRef: Ref<HTMLDivElement>;
  trayShown: boolean;
  collapsed: boolean;
  disabledProp: boolean;
  githubSyncing: string | null;
  imageSupported: boolean;
  pickFilesOrPhotos: () => Promise<void>;
  pickMedia: () => Promise<void>;
  handleTakeScreenshot: (mode: "region" | "full") => Promise<void>;
  handleCloneRepo: (repo: GithubRepo) => Promise<void>;
  handlePickSession: (session: PastSessionRef) => void;
  handlePickProject: (project: MentionProject) => void;
  handleSwitchAgent: (next: SwitchableAgent, model?: string) => void;
}) {
  // The toolbar tray, tucked under the input card. Folding, the card
  // slides down over it while it fades, so the two read as one bar
  // retracting into the input; opening runs it back. Transform and
  // opacity only, and the tray leaves the layout once, when the fold
  // lands — never a height tween, which resized the transcript above
  // every frame (`use-composer-fold.ts`). Pill labels collapse to
  // icons as the shell narrows (`composerPillLabelClass`), so the row
  // never wraps or runs past the edge.
  return (
    <div ref={trayRef} hidden={!trayShown}>
      <div
        inert={collapsed}
        // Fill: the panel-input background (near-black on the default
        // dark theme), a shade off the input card above, not a full step.
        className="mx-5 flex items-center justify-between gap-2 rounded-b-xl border border-t-0 border-[var(--border)] bg-panel-input px-2 pb-1.5 pt-2"
      >
        <div className="flex min-w-0 items-center gap-1">
          <ComposerAddMenu
            // `disabledProp`, NOT `disabled`: a missing org AI grant locks
            // the input, not the toolbar. Greying the + here made the whole
            // footer read as dead while the fix (switch agent, request a
            // grant) is one row away.
            disabled={disabledProp || githubSyncing !== null}
            projectPath={useAppStore.getState().currentProject?.path ?? null}
            agentId={switchableAgent}
            imageSupported={imageSupported}
            onAddFilesOrPhotos={() => void pickFilesOrPhotos()}
            onAttachMedia={() => void pickMedia()}
            onTakeScreenshot={(mode) => void handleTakeScreenshot(mode)}
            onCloneRepo={(repo) => void handleCloneRepo(repo)}
            onPickSession={handlePickSession}
            onPickProject={handlePickProject}
          />
          {/* Agent / mode / model as one grouped, animated picker — the
            pills double as its tab strip. Cycling shortcuts (⌥/ agents,
            ⇧⇥ Claude modes) are unchanged. The native agent's BYOK
            pickers (ProviderModelPills etc.) stay separate below. */}
          <ComposerGroupsMenu
            tabId={tabId}
            currentAgent={switchableAgent}
            onSwitchAgent={handleSwitchAgent}
          />
          {/* The BYOK ProviderModelPills used to render here for the
            native agent — the user's own provider keys, which the
            gateway agent cannot use. Model choice now goes through the
            same ACP model pill as every other agent, fed by the seam's
            published catalogue. */}
          {agentType === "atlas-agent" && <EffortPill tabId={tabId} />}
        </div>
        {/* Right side, in this order: the session's usage, the agent's own
          knobs, then the live
          implementation-plan pill hard against the right edge (arc
          progress + count; opens its own morphing task-list panel, and
          replaces the PlanDock strip that used to sit above the
          composer). Both are right-anchored dropups. */}
        <div className="flex shrink-0 items-center gap-1">
          <UsagePill tabId={tabId} />
          <ComposerOptionsPill tabId={tabId} />
          <PlanTasksPill tabId={tabId} />
        </div>
      </div>
    </div>
  );
}
