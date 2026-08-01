/** Activate a hinted element: bring it into view, then focus or click it. */

function isFocusTarget(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  // CodeMirror's editable surface.
  if (el.classList.contains("cm-content") || el.closest(".cm-editor"))
    return true;
  return false;
}

export function activate(
  el: HTMLElement,
  opts: { focusOnly?: boolean } = {},
): void {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });

  if (opts.focusOnly || isFocusTarget(el)) {
    el.focus({ preventScroll: true });
    // For text fields, drop the caret at the end for an immediate typing start.
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement;
      try {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      } catch {
        /* some input types don't support selection */
      }
    }
    return;
  }

  // Focus first (so focus-dependent handlers see it), then synthesise a click.
  el.focus({ preventScroll: true });
  el.click();
}
