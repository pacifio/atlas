/**
 * The decision a keydown gets put through, kept separate from the listener
 * that installs it so it can be reasoned about — and tested — without a DOM.
 */

import type { KeybindingScope } from "./actions";
import type { Combo } from "./combo";

/** Whether the keystroke is going into text the user is writing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

/**
 * Whether a chord is a shortcut at all in this context, or just typing.
 *
 * A chord carrying no modifier beyond Shift is indistinguishable from writing
 * a character, so while focus is in a text field only scoped commands may
 * claim one: those belong to a surface the user is deliberately inside, and
 * Shift+Tab cycling the chat's permission mode from the composer is the whole
 * point of them. A global command bound to a bare key would otherwise make its
 * letter untypeable everywhere in the app.
 */
export function isTypingRatherThanChord(
  combo: Combo,
  scope: KeybindingScope,
  editableTarget: boolean,
): boolean {
  if (!editableTarget) return false;
  if (combo.mod || combo.ctrl || combo.alt) return false;
  return scope === "global";
}
