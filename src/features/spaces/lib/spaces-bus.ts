/**
 * Space frames bypass the zustand store entirely — the draft-bus precedent.
 *
 * Binary frames arrive at drag rate (a peer's every position change, 50ms
 * awareness ticks); a store `set` per frame would re-render every subscriber
 * for bytes only ONE mounted canvas can decode. The module-level listener
 * below pipes the window channel here, and each conversation's session hook
 * subscribes directly; the rest of the app never hears about them.
 */
import { listenSpaces, type SpaceBridgeEvent } from "./spaces-api";

type Listener = (ev: SpaceBridgeEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let bridged = false;

/** Attach the app-lifetime window listener exactly once, lazily — the first
 *  mounted Space starts it; it is never torn down. */
function ensureBridge(): void {
  if (bridged) return;
  bridged = true;
  void listenSpaces((envelope) => {
    const set = listeners.get(envelope.conv);
    if (!set) return;
    for (const listener of set) listener(envelope.ev);
  });
}

export function subscribeSpaceBus(convId: string, listener: Listener): () => void {
  ensureBridge();
  let set = listeners.get(convId);
  if (!set) {
    set = new Set();
    listeners.set(convId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(convId);
  };
}
