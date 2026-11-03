import { cn } from "@/lib/utils";

/**
 * The house form language, shared with the create-organisation modal.
 *
 * Copied rather than extracted: there are two call sites, they are in different
 * features, and a shared "form kit" would have to absorb both sets of quirks to
 * earn its keep. If a third appears, extract then.
 */
export const FIELD =
  "h-8 w-full rounded-lg border border-border bg-panel-input px-2.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none transition-colors focus:border-border-strong";

/** Section heading above a group of controls. */
export const SECTION_LABEL = "text-xs font-medium text-[var(--secondary-foreground)]";

/** Hint under a group — the sentence that explains what was just chosen. */
export const HINT = "mt-1 text-2xs text-[var(--muted-foreground)]";

/** A read-only group of facts (detection, disclosure lines). */
export const GROUP =
  "rounded-lg border border-[var(--atlas-element-selected)] bg-[var(--atlas-element-hover)] px-2.5 py-2";

/** Selectable pill — the Type/Region language from the organisation modal. */
export function pillClass(state: "on" | "off" | "disabled") {
  return cn(
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs leading-none transition-colors",
    state === "disabled"
      ? "cursor-not-allowed border-border bg-panel-input text-[var(--muted-foreground)] opacity-40"
      : state === "on"
        ? "cursor-pointer border-border-strong bg-accent text-[var(--foreground)]"
        : "cursor-pointer border-border bg-panel-input text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
  );
}
