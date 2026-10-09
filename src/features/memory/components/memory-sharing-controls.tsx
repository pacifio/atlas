// Shared Cross-Agent Memory — Memory-panel header controls.
//
// Two affordances, kept to the monochrome/hairline house style (see Atlas
// Design Principles): a Shared toggle pill (white when on) and a settings
// popover holding the handoff-summarizer mode selector (Raw / Provider /
// Local-disabled), the reused ProviderModelSelector when mode === provider,
// and the "sessions outside Atlas" switch (off by default; inert while Shared
// is off, since nothing is extracted then).

import { useEffect, useMemo } from "react";
import { Popover } from "@base-ui/react/popover";
import { Share2, SlidersHorizontal, FileText, Server, Cpu, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { ProviderModelSelector } from "./provider-pickers";
import { Toggle } from "@/features/settings/components/settings-controls";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { CHAT_PROVIDERS } from "@/features/settings/lib/providers";
import { useMemorySharingStore } from "../stores/memory-sharing-store";
import type { SummarizerMode } from "../lib/memory-sharing-api";
import {
  EXTERNAL_SESSIONS_HINT,
  EXTERNAL_SESSIONS_LABEL,
  EXTERNAL_SESSIONS_NEEDS_SHARING,
  EXTRACTION_NOTE,
  HANDOFF_HINT,
  RAW_HINT,
} from "../lib/memory-sharing-copy";

export function MemorySharingControls({ projectPath }: { projectPath: string | null }) {
  const enabled = useMemorySharingStore.use.enabled();
  const pref = useMemorySharingStore.use.pref();
  const fromExternalSessions = useMemorySharingStore.use.fromExternalSessions();
  const { load, setEnabled, setFromExternalSessions, setPref } =
    useMemorySharingStore.use.actions();

  const byokKeys = useByokStore.use.keys();
  const byokLoaded = useByokStore.use.loaded();
  const loadByok = useByokStore.use.actions().load;

  useEffect(() => {
    if (projectPath) void load(projectPath);
  }, [projectPath, load]);

  useEffect(() => {
    if (!byokLoaded) void loadByok();
  }, [byokLoaded, loadByok]);

  const configured = useMemo(
    () =>
      CHAT_PROVIDERS.filter((p) => !!byokKeys[p.id]).map((p) => ({
        id: p.id,
        name: p.name,
      })),
    [byokKeys],
  );
  const providerReady = configured.length > 0;

  const setMode = (mode: SummarizerMode) => void setPref({ ...pref, mode });

  return (
    <div className="flex items-center gap-1">
      {/* Shared toggle */}
      <button
        type="button"
        onClick={() => void setEnabled(!enabled)}
        title={
          enabled
            ? "Shared memory ON — served to agents as the atlas_memory tools"
            : "Shared memory OFF"
        }
        className={cn(
          "flex items-center gap-1 h-6 px-2 rounded-full border text-2xs font-medium transition-colors cursor-pointer outline-none",
          enabled
            ? "border-[var(--border)] bg-[var(--atlas-element-hover)] text-[var(--foreground)]"
            : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)]",
        )}
      >
        <Share2 size={11} />
        Shared
      </button>

      {/* Summarizer settings popover */}
      <Popover.Root>
        <Hint label="Memory sharing settings">
          <Popover.Trigger
            render={
              <button
                type="button"
                className="flex items-center justify-center h-6 w-6 rounded-full border border-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] outline-none transition-colors cursor-pointer"
              >
                <SlidersHorizontal size={12} />
              </button>
            }
          />
        </Hint>
        <Popover.Portal>
          <Popover.Positioner className="z-popover" align="end" side="bottom" sideOffset={6}>
            <Popover.Popup className="w-[300px] rounded-md border border-border bg-card p-3 shadow-md">
              <div className="eyebrow mb-2">Recent-session handoff</div>
              <p className="mb-2.5 text-xs leading-snug text-muted-foreground">{HANDOFF_HINT}</p>

              <div className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5">
                <ModeSeg
                  active={pref.mode === "raw"}
                  label="Raw"
                  icon={FileText}
                  enabled
                  onClick={() => setMode("raw")}
                />
                <ModeSeg
                  active={pref.mode === "provider"}
                  label="Provider"
                  icon={Server}
                  enabled={providerReady}
                  onClick={() => setMode("provider")}
                />
                <ModeSeg
                  active={pref.mode === "local"}
                  label="Local"
                  icon={Cpu}
                  enabled={false}
                  onClick={() => {}}
                />
              </div>

              {pref.mode === "provider" && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {providerReady ? (
                    <ProviderModelSelector
                      configured={configured}
                      provider={pref.provider}
                      model={pref.model}
                      onProvider={(provider) => void setPref({ ...pref, provider, model: "" })}
                      onModel={(model) => void setPref({ ...pref, model })}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Add a provider key in Settings to use provider summaries.
                    </p>
                  )}
                </div>
              )}

              {pref.mode === "raw" && (
                <p className="mt-2.5 text-xs text-muted-foreground">{RAW_HINT}</p>
              )}

              <p className="mt-2.5 text-xs text-muted-foreground">{EXTRACTION_NOTE}</p>

              <div className="mt-3 border-t border-border pt-3">
                <div className="flex items-start justify-between gap-3">
                  <div className={cn(!enabled && "opacity-60")}>
                    <p className="text-xs font-medium text-foreground">{EXTERNAL_SESSIONS_LABEL}</p>
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                      {EXTERNAL_SESSIONS_HINT}
                    </p>
                    {!enabled && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {EXTERNAL_SESSIONS_NEEDS_SHARING}
                      </p>
                    )}
                  </div>
                  <Toggle
                    label={EXTERNAL_SESSIONS_LABEL}
                    checked={fromExternalSessions}
                    disabled={!enabled}
                    // The popover is card-coloured: the default off track
                    // would vanish into it, leaving a floating thumb.
                    className={cn(!fromExternalSessions && "bg-[var(--atlas-element-hover)]")}
                    onChange={(on) => void setFromExternalSessions(on)}
                  />
                </div>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function ModeSeg({
  active,
  label,
  icon: Icon,
  enabled,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: typeof Cpu;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => enabled && onClick()}
      title={enabled ? label : `${label} (coming soon)`}
      className={cn(
        "flex items-center gap-1 h-[22px] px-2 rounded-full text-2xs font-medium transition-colors",
        active
          ? "bg-[var(--atlas-element-hover)] text-[var(--foreground)]"
          : "text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
        !enabled && "opacity-40 cursor-not-allowed",
      )}
    >
      <Icon size={11} />
      {label}
      {active && <Check size={10} className="text-foreground" />}
    </button>
  );
}
