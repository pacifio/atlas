// Shared Cross-Agent Memory — Memory-panel header controls.
//
// Two affordances, kept to the monochrome/hairline house style (see Atlas
// Design Principles): a Shared toggle pill (white when on) and a settings
// popover holding the handoff-summarizer mode selector (Raw / Provider /
// Local-disabled) plus the reused ProviderModelSelector when mode === provider.

import { useEffect, useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Share2, SlidersHorizontal, FileText, Server, Cpu, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProviderModelSelector } from "./provider-pickers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { CHAT_PROVIDERS } from "@/features/settings/lib/providers";
import { useMemorySharingStore } from "../stores/memory-sharing-store";
import type { SummarizerMode } from "../lib/memory-sharing-api";

export function MemorySharingControls({ projectPath }: { projectPath: string | null }) {
  const enabled = useMemorySharingStore.use.enabled();
  const pref = useMemorySharingStore.use.pref();
  const { load, setEnabled, setPref } = useMemorySharingStore.use.actions();

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
          enabled ? "Shared memory ON — injected into agents on first send" : "Shared memory OFF"
        }
        className={cn(
          "flex items-center gap-1 h-6 px-2 rounded-full border text-[10px] font-medium transition-colors cursor-pointer outline-none",
          enabled
            ? "border-[var(--border-default)] bg-[var(--bg-hover)] text-[var(--text-primary)]"
            : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
        )}
      >
        <Share2 size={11} />
        Shared
      </button>

      {/* Summarizer settings popover */}
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            title="Handoff summarizer settings"
            className="flex items-center justify-center h-6 w-6 rounded-full border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none transition-colors cursor-pointer"
          >
            <SlidersHorizontal size={12} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            side="bottom"
            sideOffset={6}
            className="z-[9999] w-[300px] rounded-md border border-border-default bg-bg-elevated p-3 shadow-[var(--shadow-overlay)]"
          >
            <div className="eyebrow mb-2">Recent-session handoff</div>
            <p className="mb-2.5 text-[11px] leading-snug text-text-tertiary">
              How the previous session's tail is summarized before it is injected into the next
              agent.
            </p>

            <div className="inline-flex items-center gap-0.5 rounded-full border border-border-default bg-bg-elevated p-0.5">
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
                  <p className="text-[11px] text-text-tertiary">
                    Add a provider key in Settings to use provider summaries.
                  </p>
                )}
              </div>
            )}

            {pref.mode === "raw" && (
              <p className="mt-2.5 text-[11px] text-text-tertiary">
                Injecting the last turns verbatim — no model call, no latency.
              </p>
            )}
          </Popover.Content>
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
        "flex items-center gap-1 h-[22px] px-2 rounded-full text-[10px] font-medium transition-colors",
        active
          ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
        !enabled && "opacity-40 cursor-not-allowed",
      )}
    >
      <Icon size={11} />
      {label}
      {active && <Check size={10} className="text-text-primary" />}
    </button>
  );
}
