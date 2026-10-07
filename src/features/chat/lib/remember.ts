import { useChatStore } from "@/features/chat/stores/chat-store";
import { isBusyAgentStatus } from "@/types/agent";

/**
 * `/remember` is a bundled skill (`src-tauri/resources/skills/remember`): it
 * asks an agent to record what the conversation established in Atlas's
 * shared memory. Atlas seeds it into `~/.agents/skills`, and every agent that
 * can see it advertises it over ACP like any other skill, so the composer has
 * no row or expansion of its own for it (ADR-0005).
 *
 * What lives here is what save-before-switch (`switch-agent.ts`) needs: the
 * check against what the agent advertises (capability over the wire,
 * ADR-0002), the message it sends, and the wait for that turn.
 */

/** The command's name, as an agent advertises it. */
export const REMEMBER_COMMAND = "remember";

/** What save-before-switch sends: the plain passthrough command. */
export const REMEMBER_MESSAGE = `/${REMEMBER_COMMAND}`;

/** Whether the session's agent advertises `/<name>` in its ACP command list.
 *  Same normalization as the slash picker: a leading `/` is not part of it. */
export function advertisesCommand(
  sess: { availableCommands?: unknown[] } | undefined,
  name: string,
): boolean {
  return (sess?.availableCommands ?? []).some((c) => {
    const n = ((c ?? {}) as { name?: unknown }).name;
    return typeof n === "string" && n.replace(/^\//, "") === name;
  });
}

/** True for a user turn that invoked `/remember`, with or without a focus. */
export function isRememberTurn(content: string): boolean {
  const t = content.trim();
  return t === REMEMBER_MESSAGE || t.startsWith(`${REMEMBER_MESSAGE} `);
}

/**
 * How a waited-on turn came out:
 * - `finished`: it ran and ended normally;
 * - `failed`: it ran and ended in an error;
 * - `not-started`: it had not started after `startTimeoutMs`;
 * - `timeout`: it started, and was still running after `timeoutMs`;
 * - `cancelled`: the caller stopped waiting (`signal`);
 * - `gone`: the tab's session disappeared.
 */
export type TurnEnd = "finished" | "failed" | "not-started" | "timeout" | "cancelled" | "gone";

/**
 * Resolve once the tab's next turn has run and ended: the session goes busy
 * (or holds a first message waiting on its bind) and then comes back to rest.
 * Waiting for "not busy" alone would resolve before a just-sent message even
 * starts. A session that is busy already counts as started.
 */
export function awaitTurnEnd(
  tabId: string,
  opts: { timeoutMs: number; startTimeoutMs?: number; signal?: AbortSignal },
): Promise<TurnEnd> {
  return new Promise((resolve) => {
    let sawBusy = false;
    let settled = false;
    const finish = (result: TurnEnd) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      clearTimeout(startTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const check = () => {
      const sess = useChatStore.getState().sessions[tabId];
      if (!sess) return finish("gone");
      const busy = isBusyAgentStatus(sess.status) || !!sess.pendingSend;
      if (busy) sawBusy = true;
      else if (sawBusy) finish(sess.status === "error" ? "failed" : "finished");
    };
    const onAbort = () => finish("cancelled");
    const unsubscribe = useChatStore.subscribe(check);
    const timer = setTimeout(() => finish("timeout"), opts.timeoutMs);
    const startTimer =
      opts.startTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (!sawBusy) finish("not-started");
          }, opts.startTimeoutMs);
    if (opts.signal?.aborted) return finish("cancelled");
    opts.signal?.addEventListener("abort", onAbort);
    check();
  });
}
