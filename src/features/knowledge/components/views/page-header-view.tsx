import type { ReactNode } from "react";
import { Hint } from "@tryatlas/design";

/** A note's cover strip, icon button and title input. Every value and
 *  handler comes from `PageHeaderWithIcon`; `pickers` is its icon/cover
 *  popovers, rendered last inside the header. */
export function PageHeaderView({
  cover,
  coverBackground,
  icon,
  titleDraft,
  onTitleDraftChange,
  onTitleCommit,
  onTitleCancel,
  onOpenCoverPicker,
  onOpenIconPicker,
  pickers,
}: {
  /** The stored cover ref; `null` when the page has none. Keys the strip. */
  cover: string | null;
  /** The strip's resolved CSS `background`. */
  coverBackground: string;
  icon: string;
  titleDraft: string;
  onTitleDraftChange: (value: string) => void;
  onTitleCommit: () => void;
  /** Escape: reset the draft to the committed title. */
  onTitleCancel: () => void;
  onOpenCoverPicker: (anchor: DOMRect) => void;
  onOpenIconPicker: (anchor: DOMRect) => void;
  pickers: ReactNode;
}) {
  return (
    <div data-view="page-header" className="mb-3.5">
      {/* Cover strip — 180px, hidden when not set. Add-cover button
          appears just above the title when none exists. */}
      {cover ? (
        <div
          // Key on the resolved cover ref so React fully remounts the
          // element when it flips between gradient ↔ image ↔ absent —
          // belt-and-braces against any background-image cache holding
          // a stale URL after a cover swap or remove.
          key={cover}
          className="relative mb-3.5 h-[180px] cursor-pointer overflow-hidden rounded-xl border border-border-subtle"
          style={{ background: coverBackground }}
          onClick={(e) => onOpenCoverPicker(e.currentTarget.getBoundingClientRect())}
          title="Click to change cover"
        />
      ) : null}

      {!cover && (
        <div className="mb-1 flex gap-3">
          <button
            type="button"
            onClick={(e) => onOpenCoverPicker(e.currentTarget.getBoundingClientRect())}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-fast hover:text-secondary-foreground"
          >
            Add cover
          </button>
        </div>
      )}

      <div className="mt-2.5 flex items-start gap-3.5">
        <Hint label="Change icon">
          <button
            type="button"
            onClick={(e) => onOpenIconPicker(e.currentTarget.getBoundingClientRect())}
            className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-card text-2xl leading-none transition-colors duration-fast hover:bg-element-hover"
          >
            {icon}
          </button>
        </Hint>
        <div className="min-w-0 flex-1">
          <input
            value={titleDraft}
            placeholder="Untitled"
            aria-label="Page title"
            onChange={(e) => onTitleDraftChange(e.target.value)}
            onBlur={onTitleCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onTitleCommit();
                (e.currentTarget as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                onTitleCancel();
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            className="mt-0.5 block w-full border-0 bg-transparent p-0 font-sans text-2xl leading-tight font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {pickers}
    </div>
  );
}
