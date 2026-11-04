// The composer's grouped agent / mode / model picker, drawn: the shared
// morphing panel and the pill tab strip. Props-only — `composer-groups-menu.tsx`
// owns the open group, the session's modes and models, and the picks.

import type { ReactNode, Ref } from "react";
import { Check, ChevronDown, Cpu, Loader2, Plus, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentMark } from "@/components/brand-marks";
import {
  CLAUDE_PERMISSION_MODE_LABEL,
  CLAUDE_PERMISSION_MODES,
  type ClaudePermissionMode,
} from "@/types/agent";
import { capitalizeModelName, modelLabel } from "../../lib/model-label";
import {
  acpModeColor,
  claudeModeDotClass,
  displayModeName,
  type ComposerGroup,
} from "../../lib/composer-modes";
import { ModelPicker, type PickerAgent } from "../model-picker";
import { FeaturedAgentOffers } from "../featured-agent-offers";
import { composerPillClass, composerPillLabelClass } from "../../lib/composer-pill-class";
import { Button, EmptyState, Hint, Spinner } from "@tryatlas/design";

type AcpMode = { id: string; name: string; description?: string | null };
type PickerModel = PickerAgent["models"][number];

export function ComposerGroupsPanel({
  rootRef,
  contentRef,
  openGroup,
  dir,
  panelHeight,
  agentType,
  currentAgentLabel,
  cycleAgentHint,
  isClaude,
  showMode,
  permissionMode,
  hasAcpModes,
  availableModes,
  currentMode,
  currentAcpMode,
  modesPending,
  pickerAgents,
  currentModel,
  currentModelInfo,
  refreshingModels,
  onToggle,
  onPickClaudeMode,
  onPickAcpMode,
  onPickModel,
  onRefreshModels,
  onAgentInstalled,
  onAddMoreAgents,
}: {
  rootRef: Ref<HTMLDivElement>;
  contentRef: Ref<HTMLDivElement>;
  openGroup: ComposerGroup | null;
  dir: number;
  panelHeight: number;
  agentType: string;
  currentAgentLabel: string;
  cycleAgentHint: string | undefined;
  isClaude: boolean;
  showMode: boolean;
  permissionMode: ClaudePermissionMode;
  hasAcpModes: boolean;
  availableModes: readonly AcpMode[] | undefined;
  currentMode: string | undefined;
  currentAcpMode: AcpMode | undefined;
  modesPending: boolean;
  pickerAgents: PickerAgent[];
  currentModel: string | undefined;
  currentModelInfo: PickerModel | undefined;
  refreshingModels: boolean;
  onToggle: (g: ComposerGroup) => void;
  onPickClaudeMode: (m: ClaudePermissionMode) => void;
  onPickAcpMode: (id: string) => void;
  onPickModel: (agentType: string, modelId: string | null) => void;
  onRefreshModels: () => unknown;
  onAgentInstalled: (installed: string) => void;
  onAddMoreAgents: () => void;
}): ReactNode {
  // Labels stay visible on every pill — the reference folds unselected tabs
  // to icon-only, but on a toolbar whose pills are real controls that reads
  // worse than it looks (deliberately skipped).
  return (
    <div ref={rootRef} className="relative flex items-center gap-1">
      {/* Shared morphing panel — ONE container whose height tweens to the
            measured size of whatever group is showing (ResizeObserver on the
            content), so open/close AND group→group switches all animate through
            the same surface — the reference's shared-layout feel. */}
      <div
        aria-hidden={!openGroup}
        className={cn(
          // The app's own background (black, or white on a light theme) with
          // a hairline ring: the grey `popover` fill read as a slab under the
          // picker's tinted dividers.
          //
          // `transform-gpu`: the surface keeps its own compositing layer. The
          // welcome cards above the composer lift on hover with a translate,
          // which promotes THEM to a layer, and WebKit then painted that layer
          // over the part of this panel it overlapped — the search bar and the
          // fill vanished while the rows (painted later) stayed.
          "absolute bottom-full left-0 z-popover mb-1.5 transform-gpu overflow-hidden rounded-lg bg-background text-foreground shadow-md ring-1 ring-foreground/10",
          // The model group carries an agent rail beside its list, so it
          // takes more room; the width tweens with the height.
          openGroup === "model" ? "w-99" : "w-75",
        )}
        style={{
          height: openGroup ? panelHeight : 0,
          opacity: openGroup ? 1 : 0,
          pointerEvents: openGroup ? "auto" : "none",
          transition:
            "height 260ms cubic-bezier(0.32,0.72,0,1), width 260ms cubic-bezier(0.32,0.72,0,1), opacity 180ms ease-out",
        }}
      >
        <div ref={contentRef}>
          <div
            key={openGroup ?? "none"}
            className={cn(dir > 0 ? "atlas-group-slide-left" : "atlas-group-slide-right")}
          >
            {openGroup === "mode" && isClaude && (
              <div className="p-1">
                {CLAUDE_PERMISSION_MODES.map((m) => {
                  const active = m === permissionMode;
                  return (
                    <button
                      key={m}
                      onClick={() => onPickClaudeMode(m)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                        active ? "bg-element-selected" : "hover:bg-element-hover",
                      )}
                    >
                      <span
                        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", claudeModeDotClass(m))}
                      />
                      <span className="flex-1 label">{CLAUDE_PERMISSION_MODE_LABEL[m]}</span>
                      {active && <Check size={11} className="text-primary" />}
                    </button>
                  );
                })}
              </div>
            )}

            {openGroup === "mode" && !isClaude && (
              <div className="p-1">
                {!hasAcpModes ? (
                  <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
                    <Loader2 size={11} className="animate-spin" /> Loading modes…
                  </div>
                ) : (
                  availableModes!.map((m) => {
                    const active = m.id === currentMode;
                    return (
                      <button
                        key={m.id}
                        onClick={() => onPickAcpMode(m.id)}
                        className={cn(
                          "flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                          active ? "bg-element-selected" : "hover:bg-element-hover",
                        )}
                      >
                        <span
                          className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: acpModeColor(m.id) }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 label">
                            {displayModeName(m.name)}
                            {active && <Check size={11} className="text-primary" />}
                          </span>
                          {m.description && (
                            <span className="mt-0.5 block text-3xs leading-snug text-muted-foreground">
                              {m.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {openGroup === "model" && (
              <ModelPicker
                agents={pickerAgents}
                currentAgent={agentType}
                currentModel={currentModel}
                onPick={onPickModel}
                toolbar={(a) =>
                  a === "atlas-agent" && (
                    // The gateway's list, re-fetched on demand (ADR-0007).
                    // Same icon, spin and disabled idiom as the grant bar's
                    // Refresh — no new pattern.
                    <Hint label="Refresh models" side="top">
                      <button
                        type="button"
                        disabled={refreshingModels}
                        onClick={() => void onRefreshModels()}
                        className={cn(
                          "shrink-0 rounded p-0.5 text-muted-foreground transition-colors",
                          refreshingModels
                            ? "cursor-default"
                            : "cursor-pointer hover:text-foreground",
                        )}
                      >
                        <RotateCw size={12} className={cn(refreshingModels && "animate-spin")} />
                      </button>
                    </Hint>
                  )
                }
                emptyState={(a) =>
                  // An empty native list is the gateway not having answered
                  // (ADR-0007): loading while the fetch is out, then a
                  // Refresh in the body. Never a hardcoded fallback list.
                  a !== "atlas-agent" ? undefined : refreshingModels ? (
                    <div
                      role="status"
                      className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground"
                    >
                      <Spinner size="sm" label="" />
                      Loading models…
                    </div>
                  ) : (
                    <EmptyState
                      icon={Cpu}
                      title="No models from the gateway"
                      description="Couldn't load the model list. Check your connection or sign in, then refresh."
                      action={
                        <Button size="sm" variant="outline" onClick={() => void onRefreshModels()}>
                          Refresh
                        </Button>
                      }
                    />
                  )
                }
                addView={
                  <div>
                    {/* Atlas ships no ACP agents (ADR-0002), so without this a
                          fresh profile's picker lists exactly one agent and reads
                          like Atlas supports one. */}
                    <FeaturedAgentOffers onInstalled={onAgentInstalled} />
                    <div className="h-px bg-border-subtle" />
                    <button
                      onClick={onAddMoreAgents}
                      className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-xs text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
                    >
                      <Plus size={11} className="shrink-0" />
                      Add more agents
                    </button>
                  </div>
                }
              />
            )}
          </div>
        </div>
      </div>

      {/* Pill tab strip. One pill for the agent and its model: the agent's
            mark, then the model — or the agent's name while it has no model
            list to pick from. */}
      <button
        onClick={() => onToggle("model")}
        className={composerPillClass(openGroup === "model")}
        title={
          cycleAgentHint
            ? `${currentAgentLabel} — pick an agent and model here, ${cycleAgentHint} cycles agents`
            : `${currentAgentLabel} — pick an agent and model`
        }
      >
        <AgentMark agentType={agentType} className="!h-4 !w-4 !text-3xs !rounded" />
        {/* `leading-normal` undoes the pill's `leading-none` here: `truncate`
              clips at the line box, and a one-em box cuts off descenders. */}
        <span
          className={cn(
            composerPillLabelClass(),
            "max-w-[96px] truncate leading-normal @[460px]:max-w-[140px]",
          )}
        >
          {currentModelInfo
            ? modelLabel(currentModelInfo)
            : currentModel
              ? capitalizeModelName(currentModel)
              : currentAgentLabel}
        </span>
        <ChevronDown size={10} className="ml-0.5 shrink-0 text-muted-foreground" />
      </button>

      {showMode && (
        <button
          onClick={() => onToggle("mode")}
          className={composerPillClass(openGroup === "mode")}
          title="Permission mode — pick here, ⇧⇥ cycles"
        >
          {isClaude ? (
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                claudeModeDotClass(permissionMode),
              )}
            />
          ) : (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: acpModeColor(currentMode) }}
            />
          )}
          <span className={composerPillLabelClass("late")}>
            {isClaude
              ? CLAUDE_PERMISSION_MODE_LABEL[permissionMode]
              : currentAcpMode
                ? displayModeName(currentAcpMode.name)
                : modesPending
                  ? "Loading…"
                  : "Mode"}
          </span>
        </button>
      )}
    </div>
  );
}
