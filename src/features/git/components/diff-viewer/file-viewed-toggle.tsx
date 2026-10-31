import { createContext, memo, use, type ReactNode } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { Hint } from "@/ui/tooltip";

/** What a file header's "Viewed" box reads and writes. */
export interface FileViewedState {
  isViewed: (path: string) => boolean;
  /** Marked viewed, and the file's diff has changed since. */
  isStale: (path: string) => boolean;
  setViewed: (id: string, path: string, viewed: boolean) => void;
}

/**
 * The viewer memoizes each header's portal on its render props, so the box
 * reads its state through context: a press redraws the boxes, not every
 * header on screen. The item's `version` carries the viewed mark so the
 * viewer re-renders the one header whose mark moved.
 */
export const FileViewedContext = createContext<FileViewedState | null>(null);

/** The header's tail: the file's counts, then its "Viewed" box. */
export const FileViewedToggle = memo(function FileViewedToggle({
  id,
  path,
  stat,
}: {
  id: string;
  path: string;
  stat: ReactNode;
}) {
  const state = use(FileViewedContext);
  if (!state) return stat;
  const viewed = state.isViewed(path);
  const stale = state.isStale(path);
  return (
    <span className="flex items-center gap-3">
      {stat}
      {/* A click here must not reach the header, which opens the file. */}
      <label
        data-viewed-toggle=""
        className="flex cursor-pointer items-center gap-1.5 font-sans text-2xs text-muted-foreground select-none"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Named by the label around it: "Viewed", or the stale note. */}
        <Checkbox.Root
          checked={viewed}
          onCheckedChange={(next) => state.setViewed(id, path, next)}
          className="flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-[var(--atlas-border-strong)] bg-transparent text-primary-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring data-checked:border-primary data-checked:bg-primary"
        >
          <Checkbox.Indicator>
            <Check size={10} strokeWidth={3} />
          </Checkbox.Indicator>
        </Checkbox.Root>
        {stale ? (
          <Hint label="This file has changed since you marked it viewed.">
            <span className="text-warning">Changed</span>
          </Hint>
        ) : (
          <span>Viewed</span>
        )}
      </label>
    </span>
  );
});
