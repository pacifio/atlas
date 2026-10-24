import { toast } from "sonner";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { LAYOUT_TEMPLATES, type LayoutTemplate } from "@/features/layout/templates";
import { LayoutThumbnail } from "@/features/layout/components/layout-thumbnail";
import { SettingsPage, SettingsSection } from "./layout/settings-layout";

/** Settings → Layouts: the same predefined templates the ⌘⌥L switcher offers,
 *  applied with a click. */
export function LayoutsSettings() {
  const switcherHint = useActionShortcut("nav.layoutSwitcher")?.label ?? "⌘⌥L";
  const apply = (t: LayoutTemplate) => {
    useLayoutStore.getState().actions.applyLayoutTemplate(t);
    toast.success(`Applied “${t.name}” layout`);
  };

  return (
    <SettingsPage
      title="Layouts"
      description={`Rearrange panels and tabs into a ready-made project. ${switcherHint} switches layouts from anywhere.`}
    >
      <SettingsSection title="Templates">
        <div className="grid grid-cols-2 gap-3">
          {LAYOUT_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => apply(t)}
              className={cn(
                "rounded-lg border border-border bg-card p-3 text-left",
                "transition-colors duration-fast ease-out-strong hover:border-border-strong hover:bg-element-hover",
              )}
            >
              <LayoutThumbnail template={t} />
              <div className="label mt-2">{t.name}</div>
              <div className="caption">{t.description}</div>
            </button>
          ))}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
