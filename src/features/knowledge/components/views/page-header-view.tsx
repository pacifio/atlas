import type { ReactNode } from "react";
import { Hint } from "@/ui/tooltip";

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
    <div style={{ marginBottom: 14 }}>
      {/* Cover strip — 180px, hidden when not set. Add-cover button
          appears just above the title when none exists. */}
      {cover ? (
        <div
          // Key on the resolved cover ref so React fully remounts the
          // element when it flips between gradient ↔ image ↔ absent —
          // belt-and-braces against any background-image cache holding
          // a stale URL after a cover swap or remove.
          key={cover}
          style={{
            height: 180,
            borderRadius: 10,
            border: "1px solid var(--border-subtle)",
            margin: "0 0 14px",
            background: coverBackground,
            position: "relative",
            cursor: "pointer",
          }}
          onClick={(e) => onOpenCoverPicker(e.currentTarget.getBoundingClientRect())}
          title="Click to change cover"
        />
      ) : null}

      <div
        className="text-sm"
        style={{
          display: "flex",
          gap: 12,
          color: "var(--muted-foreground)",
          opacity: 0.85,
          marginBottom: 4,
        }}
      >
        {!cover && (
          <button
            type="button"
            onClick={(e) => onOpenCoverPicker(e.currentTarget.getBoundingClientRect())}
            className="text-sm"
            style={{
              background: "transparent",
              border: 0,
              padding: 0,
              color: "var(--muted-foreground)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            Add cover
          </button>
        )}
      </div>

      <div className="flex items-start" style={{ gap: 14, marginTop: 10 }}>
        <Hint label="Change icon">
          <button
            onClick={(e) => onOpenIconPicker(e.currentTarget.getBoundingClientRect())}
            className="text-2xl"
            style={{
              width: 44,
              height: 44,
              borderRadius: 9,
              background: "var(--card)",
              border: "1px solid var(--border-subtle)",
              lineHeight: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
              cursor: "pointer",
            }}
          >
            {icon}
          </button>
        </Hint>
        <div className="flex-1 min-w-0">
          <input
            value={titleDraft}
            placeholder="Untitled"
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
            className="text-2xl"
            style={{
              display: "block",
              width: "100%",
              lineHeight: 1.15,
              margin: "2px 0 0",
              letterSpacing: "-0.03em",
              color: "var(--foreground)",
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
              background: "transparent",
              border: 0,
              padding: 0,
              outline: "none",
            }}
          />
        </div>
      </div>

      {pickers}
    </div>
  );
}
