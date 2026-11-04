import { Check, CircleAlert, CircleCheck, Copy, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ToasterProps } from "sonner";
import { copyText } from "@/lib/clipboard";
import { Icon } from "@tryatlas/design";

/**
 * The glyphs every typed toast wears, and the copy button that rides with them.
 *
 * Why the copy button lives in the ICON slot: sonner renders each toast itself
 * and offers no per-toast render hook on the `<Toaster>` — the only global,
 * per-toast React nodes it accepts are `icons`. So each type's icon renders the
 * glyph AND a copy button, and globals.css flattens sonner's `[data-icon]` box
 * (`display: contents`) and uses `order` to move the button to the right of the
 * text. The alternative was editing every `toast.error(…)` call site, or
 * monkey-patching the `toast` singleton.
 *
 * The button reads the text back out of the rendered toast rather than from the
 * call's arguments, which it never sees: title, then the description on its own
 * line. Reading the DOM also means a ReactNode description copies as the text a
 * person sees.
 *
 * Untyped `toast("…")` and `toast.loading` keep sonner's own (absent / spinner)
 * icon and so have no copy button; a call site that passes its own `icon`
 * replaces this one, button included.
 */

/** The text a toast shows: its title, then its description on a new line. */
export function toastCopyText(toast: Element | null): string {
  if (!toast) return "";
  const part = (selector: string) => toast.querySelector(selector)?.textContent?.trim() ?? "";
  return [part("[data-title]"), part("[data-description]")].filter(Boolean).join("\n");
}

function ToastCopyButton() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      data-toast-copy=""
      aria-label={copied ? "Copied" : "Copy message"}
      onClick={(event) => {
        const text = toastCopyText(event.currentTarget.closest("[data-sonner-toast]"));
        if (!text) return;
        void copyText(text).then(setCopied);
      }}
      className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-element-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {copied ? (
        <Icon icon={Check} size="sm" className="pointer-events-none text-success" />
      ) : (
        <Icon icon={Copy} size="sm" className="pointer-events-none" />
      )}
    </button>
  );
}

function ToastIcon({ glyph }: { glyph: ReactNode }) {
  return (
    <>
      <span data-toast-glyph="">{glyph}</span>
      <ToastCopyButton />
    </>
  );
}

/** Each type's glyph alone. A call site passes one as its `icon` to keep the
 *  look but drop the copy button — a toast whose own action already copies
 *  something ("Copy link") would otherwise offer two copy buttons that copy
 *  different things. */
export const TOAST_GLYPHS = {
  success: <Icon icon={CircleCheck} size="lg" className="text-success" />,
  info: <Icon icon={Info} size="lg" className="text-info" />,
  warning: <Icon icon={TriangleAlert} size="lg" className="text-warning" />,
  error: <Icon icon={CircleAlert} size="lg" className="text-error" />,
};

export const TOAST_ICONS: ToasterProps["icons"] = {
  success: <ToastIcon glyph={TOAST_GLYPHS.success} />,
  info: <ToastIcon glyph={TOAST_GLYPHS.info} />,
  warning: <ToastIcon glyph={TOAST_GLYPHS.warning} />,
  error: <ToastIcon glyph={TOAST_GLYPHS.error} />,
  close: <Icon icon={X} size="xs" />,
};
