import { useLayoutStore } from "../stores/layout-store";
import { LAYOUT_TEMPLATES, type LayoutTemplate } from "../templates";
import { LayoutSwitcherView } from "./views/layout-switcher-view";

/** The layout switcher (⌘⌥L): applies a template to the layout store and
 *  closes. The grid and its keys are `LayoutSwitcherView`. */
export function LayoutSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const apply = (t: LayoutTemplate) => {
    useLayoutStore.getState().actions.applyLayoutTemplate(t);
    onOpenChange(false);
  };
  return (
    <LayoutSwitcherView
      open={open}
      onOpenChange={onOpenChange}
      templates={LAYOUT_TEMPLATES}
      onApply={apply}
    />
  );
}
