import { useMemo } from "react";
import { Upload, X } from "lucide-react";
import { Button, Icon, Popover, PopoverContent, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import type { CoverGradient } from "../../lib/cover-gradients";

/**
 * The page-cover picker: gradient swatches, "Upload from disk" and, when the
 * page has a cover, "Remove cover". A popover anchored to the rect the caller
 * measured; Base UI owns Escape, the outside press and collision flipping.
 *
 * The swatches paint the gradient itself — user content, so it keeps its own
 * colours in every theme (`cover-gradients.ts`).
 */
export function CoverPickerView({
  value,
  anchorRect,
  gradients,
  uploading = false,
  onPick,
  onUpload,
  onClose,
}: {
  value: string | null;
  anchorRect: DOMRect | null;
  gradients: readonly CoverGradient[];
  /** An upload is running: the button shows it and takes no second press. */
  uploading?: boolean;
  onPick: (cover: string | null) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  const anchor = useMemo(
    () => (anchorRect ? { getBoundingClientRect: () => anchorRect } : null),
    [anchorRect],
  );
  if (!anchor) return null;

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={6}
        data-view="cover-picker"
        className="w-[320px] p-2"
      >
        <div className="eyebrow px-1 pt-1 pb-1.5">Gradient</div>
        <div className="mb-2 grid grid-cols-3 gap-1.5">
          {gradients.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => {
                onPick(g.id);
                onClose();
              }}
              title={g.label}
              aria-label={g.label}
              aria-pressed={value === g.id}
              className={cn(
                "h-[50px] rounded-md",
                value === g.id ? "ring-2 ring-foreground" : "ring-1 ring-border-subtle",
              )}
              style={{ background: g.css }}
            />
          ))}
        </div>

        <Button
          variant="secondary"
          size="md"
          className="w-full"
          disabled={uploading}
          aria-busy={uploading || undefined}
          onClick={onUpload}
        >
          {uploading ? <Spinner size="xs" label="" /> : <Icon icon={Upload} size="sm" />}
          {uploading ? "Uploading…" : "Upload from disk"}
        </Button>

        {value && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1.5 w-full"
            onClick={() => {
              onPick(null);
              onClose();
            }}
          >
            <Icon icon={X} size="xs" />
            Remove cover
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
