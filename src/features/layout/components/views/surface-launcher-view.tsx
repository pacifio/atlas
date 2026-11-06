import type { Ref } from "react";
import type { Surface } from "../../lib/surfaces";
import { Kbd } from "@tryatlas/design";

/** The empty column's "Open a surface" list; its keyboard lives in
 *  `SurfaceLauncher`. */
export function SurfaceLauncherView({
  rootRef,
  surfaces,
  onPick,
}: {
  rootRef: Ref<HTMLDivElement>;
  surfaces: readonly Surface[];
  onPick: (surface: Surface) => void;
}) {
  return (
    // Lifted by the bar's height so it sits at the optical centre of the
    // window rather than the column's.
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex h-full items-center justify-center pb-(--titlebar-height) outline-none"
    >
      <div className="w-full max-w-xs px-4">
        <p className="mb-3 text-center text-sm font-medium text-foreground">Open a surface</p>
        <div className="flex flex-col gap-0.5">
          {surfaces.map((surface) => (
            <button
              key={surface.type}
              onClick={() => onPick(surface)}
              className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
            >
              <surface.icon size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{surface.label}</span>
              <Kbd>{surface.key}</Kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
