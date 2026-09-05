import type { PromptDraft } from "../types";

/**
 * Draft frames bypass the zustand store entirely.
 *
 * Yjs updates arrive at keystroke rate from every other editor of the draft;
 * a store `set` per frame would re-render every comms subscriber for bytes
 * only ONE mounted editor can even decode. `applyEnvelope` forwards the
 * three draft event kinds here, and the editor's session hook subscribes
 * directly — the rest of the app never hears about them.
 */
export type DraftBusEvent =
  | {
      kind: "opened";
      draft_id: string;
      draft: PromptDraft;
      snapshot: string | null;
      updates: string[];
    }
  | { kind: "update"; draft_id: string; update: string }
  | { kind: "awareness"; draft_id: string; user_id: string; state: string };

type Listener = (ev: DraftBusEvent) => void;

const listeners = new Set<Listener>();

export function publishDraftEvent(ev: DraftBusEvent): void {
  for (const listener of listeners) listener(ev);
}

export function subscribeDraftBus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
