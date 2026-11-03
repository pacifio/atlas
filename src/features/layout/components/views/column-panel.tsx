import { useEffect } from "react";
import { Panel, usePanelRef } from "react-resizable-panels";

/**
 * One split column's panel, collapsed to zero width instead of unmounted when
 * the surfaces mode hides it. Sizes are percentages: v4 reads bare numbers as
 * PIXELS and unit-less strings as percentages. `order` is gone — panels are
 * ordered by DOM position — but `id` still keys the saved layout.
 */
export function ColumnPanel({
  id,
  shown,
  defaultSize,
  minSize = "20",
  children,
}: {
  id: string;
  shown: boolean;
  defaultSize?: string;
  /** A percentage, or a pixel floor ("320px") from the surface it shows. */
  minSize?: string;
  children: React.ReactNode;
}) {
  const panelRef = usePanelRef();
  // Synced again on the next frame: on mount the Group has not measured itself
  // yet, so a collapse or expand issued then is a no-op or throws.
  useEffect(() => {
    const sync = () => {
      const panel = panelRef.current;
      if (!panel) return;
      try {
        if (shown && panel.isCollapsed()) panel.expand();
        else if (!shown && !panel.isCollapsed()) panel.collapse();
      } catch {
        // A panel added this commit is not registered with its Group yet and
        // throws "constraints not found"; the next-frame sync handles it.
      }
    };
    sync();
    const raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [shown, panelRef]);
  return (
    <Panel
      id={id}
      panelRef={panelRef}
      collapsible
      collapsedSize="0"
      minSize={minSize}
      defaultSize={defaultSize}
      className="min-w-0"
    >
      {children}
    </Panel>
  );
}
