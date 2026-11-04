// Which error toasts offer "Fix with agent" (`toast-icons.tsx`).
//
// The button rides every `toast.error` through the Toaster's error icon, the
// one per-toast seam sonner has, so it never sees the call's arguments: it
// reads the toast's text back out of the DOM and decides from that. It shows
// when the text carries a cause — a description under the title, or a title
// that goes on past a colon or a dash ("Couldn't install X: <the error>") —
// and stays off:
//
// - for a bare failure or a notice with no cause ("Couldn't copy", "Open a
//   project before cloning a repo."), which gives an agent nothing to go on;
// - for something the user cancelled or stopped;
// - for a validation message the user fixes themselves ("… is required",
//   "… already exists").
//
// A call site whose message is one of those but slips past the patterns
// passes `icon: TOAST_ERROR_ICON_NO_FIX`.

/** Cancelled or stopped by the user. Not "aborted": a timeout aborts too,
 *  and that is a failure worth fixing. */
const CANCELLED = /\b(cancell?ed|stopped by you|you stopped|interrupted by you)\b/i;

/** A message the user acts on in the form they are in. Narrow on purpose:
 *  "must be" and "not a valid" turn up in real causes from tools
 *  ("version must be >=18", "not a valid JSON"). */
const VALIDATION =
  /\b(is|are) (required|empty)\b|\bcan(?:no|['’])t be (empty|blank)\b|\balready (exists|added|offers|in use|taken)\b|\bisn['’]t monospace\b/i;

/** A title that goes on to say why: "<what failed>: <cause>", or with a dash. */
const HAS_CAUSE = /\S\s*(:|\s[—–-])\s+\S/;

export function toastFixable(title: string, description = ""): boolean {
  const head = title.trim();
  const body = description.trim();
  const all = `${head}\n${body}`;
  if (CANCELLED.test(all) || VALIDATION.test(all)) return false;
  return body.length > 0 || HAS_CAUSE.test(head);
}
