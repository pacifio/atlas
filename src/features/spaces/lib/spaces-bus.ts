/**
 * Space frames bypass the zustand store entirely — the draft-bus precedent.
 *
 * Binary frames arrive at drag rate (a peer's every position change, 50ms
 * awareness ticks); a store `set` per frame would re-render every subscriber
 * for bytes only ONE mounted canvas can decode. The module-level listener
 * below pipes the window channel here, and each conversation's session hook
 * subscribes directly; the rest of the app never hears about them.
 */
import { listenSpaces, type SpaceBridgeEvent, type SpaceConnState } from "./spaces-api";

type Listener = (ev: SpaceBridgeEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let bridged: Promise<unknown> | null = null;
/** Each conversation socket's last reported state, whoever is listening —
 *  so a write that shares a socket a canvas opened knows whether it can
 *  send yet. Known only once the bridge is up, which every socket holder
 *  makes sure of before it connects. */
const states = new Map<string, SpaceConnState>();

/** Attach the app-lifetime window listener exactly once, lazily — the first
 *  mounted Space starts it; it is never torn down. */
function ensureBridge(): Promise<unknown> {
  bridged ??= listenSpaces((envelope) => {
    if (envelope.ev.kind === "connection") states.set(envelope.conv, envelope.ev.state);
    const set = listeners.get(envelope.conv);
    if (!set) return;
    for (const listener of set) listener(envelope.ev);
  });
  return bridged;
}

/** Resolves once the window listener is attached: a caller that is about to
 *  dial awaits it, so the socket's first events are not missed. */
export async function spaceBusReady(): Promise<void> {
  await ensureBridge();
}

/** The conversation socket's last reported state, `"disconnected"` when none
 *  was reported. */
export function spaceConnection(convId: string): SpaceConnState {
  return states.get(convId) ?? "disconnected";
}

export function subscribeSpaceBus(convId: string, listener: Listener): () => void {
  void ensureBridge();
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
