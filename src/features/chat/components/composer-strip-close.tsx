import { useCallback, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { COMPOSER_STRIP_ACTION } from "./composer-strip";
import { Hint } from "@tryatlas/design";

/**
 * The ✕ every strip tucked into the composer carries (`composer-strip.ts`).
 * One construction, so the close reads the same on every notice: the strip's
 * own quiet action style, at the far right.
 */
export function ComposerStripClose({
  onClick,
  label = "Hide",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <Hint label={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(COMPOSER_STRIP_ACTION, "cursor-pointer px-1")}
      >
        <X size={11} />
      </button>
    </Hint>
  );
}

/**
 * Hide a strip for as long as the condition it reports stays the same. `key`
 * names that condition (the session, the mode it could not restore…): a new
 * key is a new notice and shows again. Local to the composer — hiding is "not
 * now", not "never"; a strip that wants "never" keeps its own record.
 */
export function useStripHidden(key: string | null | undefined): [boolean, () => void] {
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  const hide = useCallback(() => setHiddenFor(key ?? null), [key]);
  return [key != null && hiddenFor === key, hide];
}
