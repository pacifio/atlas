/** What the shortcut reads off a key event. */
interface CommentSubmitShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
}

/**
 * ⌘Enter (Ctrl+Enter off the Mac) in a line comment's box: add it, when there
 * is something to add and nothing already on its way. An IME composition's
 * Enter is the composition's, and a held key adds once.
 */
export function isCommentSubmitShortcut(
  event: CommentSubmitShortcutEvent,
  value: string,
  pending = false,
): boolean {
  return (
    !pending &&
    !event.isComposing &&
    !event.repeat &&
    !event.shiftKey &&
    !event.altKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key === "Enter" &&
    value.trim().length > 0
  );
}
