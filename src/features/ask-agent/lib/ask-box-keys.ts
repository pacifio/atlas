// The ask box's keys, as data: ⌘↵ sends, ⌘⇧↵ drafts into the composer, Esc
// cancels, and a plain Enter is left to the field (a newline). Ctrl stands in
// for ⌘ off macOS.

export type AskKeyAction = "send" | "draft" | "cancel" | null;

export interface AskKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** An IME is composing: its Enter commits the candidate, not the box. */
  isComposing: boolean;
}

export function askKeyAction(e: AskKey): AskKeyAction {
  if (e.isComposing) return null;
  if (e.key === "Escape") return "cancel";
  if (e.key !== "Enter" || e.altKey) return null;
  if (!(e.metaKey || e.ctrlKey)) return null;
  return e.shiftKey ? "draft" : "send";
}
