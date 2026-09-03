/**
 * Whether Settings is currently listening for a chord to record.
 *
 * While it is, the dispatcher stands down: every keystroke is data the user is
 * entering, not a command they are running, and ⌘K has to be recordable
 * without opening the command palette on the way past.
 *
 * A module flag rather than a store field, and read rather than subscribed:
 * both listeners are on `window` in capture phase, so the dispatcher — which
 * registers first, at app mount — always runs first and cannot be out-ordered
 * by the recorder. Asking is the only thing that works.
 */

let recording = false;

export function setChordRecording(active: boolean): void {
  recording = active;
}

export function isChordRecording(): boolean {
  return recording;
}
