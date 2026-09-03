import { useEffect, useRef } from "react";
import { registerHandlers } from "../lib/handler-registry";

/**
 * Declare what a component does when its commands fire.
 *
 * A handler may be `undefined` for a command the component owns but cannot run
 * in its current state — the terminal's find, while an alt-screen app has
 * replaced the block history there is nothing to search. The keystroke falls
 * through in that case rather than being swallowed by a command that did
 * nothing, which is why the registration is by command *name*: it stays stable
 * while the handler comes and goes.
 *
 * Pass `tabId` from a pane so its handlers only run while that pane holds the
 * focused tab — see `handler-registry.ts`. Omit it for handlers that belong to
 * the window as a whole.
 *
 * Handlers are read through a ref, so the registration survives every render
 * while still calling the latest closure. Without that, a handler that closes
 * over changing state would re-register on each keystroke it depends on.
 */
export function useActionHandlers(
  handlers: Record<string, (() => void) | undefined>,
  tabId?: string,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  // Re-register only when the *set* of commands changes, not when the
  // functions do.
  const commands = Object.keys(handlers).sort().join(",");
  useEffect(() => {
    const stable = Object.fromEntries(
      commands
        .split(",")
        .filter(Boolean)
        .map((id) => [id, () => latest.current[id]?.()]),
    );
    return registerHandlers(stable, tabId);
  }, [commands, tabId]);
}
