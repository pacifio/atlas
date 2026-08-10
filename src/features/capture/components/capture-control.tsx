import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { AtlasIcon } from "@/components/atlas-icon";

/**
 * The Timeline entry point: one row in the Workspace switcher panel.
 *
 * Deliberately inert. It used to carry a capture-state dot and a
 * stopped/review warning, which meant polling `capture_binding` and
 * `capture_health` every 15 seconds — two fresh read-only store connections per
 * tick — for a row whose only job is navigation.
 *
 * That indicator was also answering the wrong question. The Timeline board is
 * **Organisation-scoped**: it spans every project in the active org. A dot
 * describing the *currently open project's* capture state is a fact about
 * somewhere else, sitting next to a link that does not go there. Capture state
 * belongs where capture is configured — the titlebar pill and the Timeline
 * tab's own header — both of which already show it, and neither of which had to
 * poll to find out.
 *
 * The row is no longer gated on having a project open either, for the same
 * reason: an org-wide destination should not disappear because no folder
 * happens to be focused.
 */

export function CaptureControl() {
  const { addTab } = useLayoutStore.use.actions();

  return (
    <div className="shrink-0 px-1.5 pb-1">
      <button
        type="button"
        onClick={() =>
          addTab({
            id: "artifacts",
            type: "artifacts",
            title: "Timeline",
            closable: true,
            dirty: false,
            data: {},
          })
        }
        className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-[var(--text-secondary)] outline-none transition-colors duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] active:bg-[var(--bg-active)]"
        title="Sessions recorded across this Organisation"
      >
        <AtlasIcon size={13} className="shrink-0 rounded-[3px]" />
        <span className="truncate">Timeline</span>
      </button>
    </div>
  );
}
