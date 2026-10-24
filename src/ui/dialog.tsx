import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";

/**
 * The house dialog (decision 16), built on `@base-ui/react/dialog`.
 *
 * Shaped like shadcn's base-style `dialog` — same exports (including the
 * `DialogOverlay` name for what Base UI calls the Backdrop), same `data-slot`,
 * `showCloseButton` on the content — so a later `shadcn add` drops in with the
 * classes swapped rather than the structure rewritten.
 *
 * A centred modal has **no Positioner**: the Popup places itself. Only anchored
 * popups (popover, menu, tooltip) need one.
 *
 * Scales: `rounded-xl` (the dialog step), `shadow-lg` (`--elevation-dialog`),
 * `z-overlay` for the scrim and `z-modal` for the dialog. `z-popover` sits
 * above both on purpose, so a menu opened inside a dialog escapes it.
 */

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** Radix called this the Overlay; Base UI calls it the Backdrop. */
/**
 * `blur` frosts what is behind the scrim as well as dimming it — for the
 * blocking prompts (permission, elicitation, sign-in) where the app behind
 * should read as unavailable rather than merely dimmed.
 */
function DialogOverlay({
  className,
  blur = false,
  ...props
}: DialogPrimitive.Backdrop.Props & { blur?: boolean }) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-overlay scrim",
        blur && "backdrop-blur-sm",
        "data-open:animate-fade-in data-closed:animate-fade-out",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
          "flex w-full max-w-[min(32rem,calc(100vw-2rem))] flex-col gap-3 p-4",
          "rounded-xl border border-border bg-card text-foreground shadow-lg",
          "outline-none",
          "data-open:animate-scale-in data-closed:animate-scale-out",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <IconButton icon={X} label="Close" size="sm" className="absolute top-2 right-2" />
            }
          />
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("heading text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("body text-secondary-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
