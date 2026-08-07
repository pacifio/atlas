import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { LAYOUT_TEMPLATES, type LayoutTemplate } from "@/features/layout/templates";
import { LayoutThumbnail } from "@/features/layout/components/layout-thumbnail";

/** Settings → Layouts: the same predefined templates the ⌘⌥L switcher offers,
 *  applied with a click. */
export function LayoutsSettings() {
  const apply = (t: LayoutTemplate) => {
    useLayoutStore.getState().actions.applyLayoutTemplate(t);
    toast.success(`Applied “${t.name}” layout`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">Layouts</h2>
        <p className="text-[11px] text-text-tertiary mt-0.5">
          Rearrange panels and tabs into a ready-made workspace. Press{" "}
          <kbd className="px-1 py-0.5 rounded bg-bg-elevated border border-border-default font-mono text-[9px]">
            ⌘⌥L
          </kbd>{" "}
          anytime to switch layouts.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {LAYOUT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => apply(t)}
            className={cn(
              "text-left rounded-xl border border-border-default bg-bg-secondary p-3",
              "hover:border-[var(--border-strong)] transition-colors outline-none",
            )}
          >
            <LayoutThumbnail template={t} />
            <div className="mt-2 text-[12px] font-medium text-text-primary">{t.name}</div>
            <div className="text-[10px] text-text-tertiary leading-snug">{t.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
