import type { ComponentProps, ReactNode } from "react";
import { CircleUser } from "lucide-react";
import { Hint, Icon, Spinner, iconButtonVariants } from "@tryatlas/design";

import { cn } from "@/lib/utils";

export type AccountButtonState = "signed-out" | "busy" | "signed-in";

/**
 * The account control's face: a spinner while a grant starts or runs, the
 * user's avatar when there is one, else the generic account glyph.
 *
 * The same square as every other control in the title bar (the icon button's
 * `sm`), docked or not — the bar reads as one toolbar only if nothing in it is
 * a different size. The icon button's recipe on a plain `<button>` rather than
 * `IconButton` itself, because the content is an avatar, not a glyph.
 *
 * Every prop and the ref reach the `<button>`: as the element a menu
 * trigger's `render` clones, the trigger's props must land on it.
 */
export function AccountButtonView({
  state,
  avatar,
  label,
  compact = false,
  className,
  ...props
}: ComponentProps<"button"> & {
  state: AccountButtonState;
  avatar: ReactNode | null;
  label: string;
  /** In the dock the pill's sliding label already names this control, so
   *  only the standalone button carries a tooltip of its own. */
  compact?: boolean;
}) {
  const Control = compact ? "button" : HintedButton;
  return (
    <Control
      type="button"
      {...props}
      aria-label={label}
      className={cn(
        iconButtonVariants({ variant: "ghost", size: "sm" }),
        // A `<button>` gets the arrow by default, and this one carries no
        // label or border — the pointer is most of what says it is pressable.
        "cursor-pointer",
        state === "signed-out" && "text-disabled hover:text-muted-foreground",
        className,
      )}
    >
      {state === "busy" ? (
        <Spinner size="md" label="" />
      ) : (
        (avatar ?? <Icon icon={CircleUser} size="md" />)
      )}
    </Control>
  );
}

/**
 * The button with its tooltip inside. It has to be a component that forwards
 * its props: as the element `DropdownMenu.Trigger`'s `render` clones, the
 * trigger's props and ref land here and must reach the same `<button>` the
 * tooltip trigger merges onto.
 */
function HintedButton(props: ComponentProps<"button">) {
  return (
    <Hint label={props["aria-label"] ?? ""}>
      <button {...props} />
    </Hint>
  );
}
