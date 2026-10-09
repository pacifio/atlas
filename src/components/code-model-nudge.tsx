import { useEffect } from "react";
import { toast } from "sonner";
import { Boxes, Download, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { useModelsStore } from "@/features/settings/stores/models-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import { codeModelToSuggest, downloadPercent } from "@/features/settings/lib/code-model-nudge";

const PART =
  "flex items-center h-full text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer";

/**
 * A composer pill that offers the code search model while it is missing:
 * one click downloads it, the gear opens Settings → Local Models, the cross
 * hides it for good (per model, in every composer at once). Never downloads
 * on its own: the model is large enough that it should be the user's call.
 * Hidden while agents get no code tools (`agentCodeTools`, ADR-0015): with
 * no `semantic_search` to serve, the model would buy nothing.
 *
 * Lives in `src/components` because it is a cross-feature widget: the
 * settings feature owns its state, the chat composer renders it.
 */
export function CodeModelNudge({ labelClassName }: { labelClassName?: string }) {
  const list = useModelsStore.use.list();
  const downloading = useModelsStore.use.downloading();
  const actions = useModelsStore.use.actions();
  const dismissed = useModelsStore.use.codeNudgeDismissed();
  const codeTools = useSettingsStore((s) => s.settings.agentCodeTools);

  useEffect(() => {
    void actions.init();
  }, [actions]);

  const model = codeTools ? codeModelToSuggest(list, dismissed) : null;
  if (!model) return null;

  const progress = downloading[model.id];
  const label = progress ? `Downloading ${downloadPercent(progress)}%` : "Enable semantic search";
  const hint = progress
    ? `Downloading ${model.name} for semantic code search`
    : `Code search is matching keywords only. Download ${model.name} (${model.sizeMb} MB) so plain-English questions find code too.`;

  const download = () => {
    if (progress) return;
    actions.download(model.id).catch((e) =>
      toast.error(`Download failed: ${e instanceof Error ? e.message : String(e)}`, {
        action: { label: "Local Models", onClick: () => openSettingsSection("models") },
      }),
    );
  };

  return (
    <div
      role="group"
      aria-label="Semantic code search"
      className="flex items-center h-6.5 rounded-full border border-border bg-card text-2xs leading-none font-medium overflow-hidden"
    >
      <Hint label={hint} side="top" wrap>
        <button
          type="button"
          aria-label={label}
          onClick={download}
          disabled={!!progress}
          className={cn(PART, "pl-2 pr-1.5 tabular-nums disabled:cursor-default")}
        >
          {progress ? (
            <Loader2 size={11} className="animate-spin text-primary" />
          ) : (
            <Download size={11} className="text-primary" />
          )}
          <span className={labelClassName ?? "ml-1.5 whitespace-nowrap"}>{label}</span>
        </button>
      </Hint>
      <Hint label="Open Local Models" side="top">
        <button
          type="button"
          aria-label="Open Local Models"
          onClick={() => openSettingsSection("models")}
          className={cn(PART, "px-1")}
        >
          <Boxes size={11} />
        </button>
      </Hint>
      {!progress && (
        <Hint label="Don't suggest this again" side="top">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => actions.dismissCodeNudge(model.id)}
            className={cn(PART, "pl-1 pr-2")}
          >
            <X size={11} />
          </button>
        </Hint>
      )}
    </div>
  );
}
