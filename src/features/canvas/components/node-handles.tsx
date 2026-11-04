import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

/** One connection handle per side. With `ConnectionMode.Loose` a single handle
 *  per side connects in either direction, giving full 4-way linking. Shared by
 *  every canvas node type so anything can be wired into a mind map. */
const SIDES: Array<{ id: string; position: Position }> = [
  { id: "t", position: Position.Top },
  { id: "r", position: Position.Right },
  { id: "b", position: Position.Bottom },
  { id: "l", position: Position.Left },
];

export function NodeHandles({ selected }: { selected?: boolean }) {
  return (
    <>
      {SIDES.map((s) => (
        <Handle
          key={s.id}
          id={s.id}
          type="source"
          position={s.position}
          className={cn(
            // High z so a dot is never painted under node content (e.g. the
            // note-body fade gradient) or clipped by it.
            "!z-panel !w-3 !h-3 !rounded-full !border !border-background !bg-primary transition-opacity",
            selected ? "opacity-90" : "opacity-0 group-hover:opacity-100",
          )}
        />
      ))}
    </>
  );
}
