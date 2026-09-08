// Whether a session can retry its last turn.
//
// Split out from `retry-turn.ts` so the predicate carries none of the action's
// weight: the transcript evaluates it inside a store selector on the hot
// render path, and `retry-turn` reaches IPC, toasts and the log store. A pure
// module is also the only way to test the gate without standing up Tauri's
// event bridge.

import { isBusyAgentStatus, type ChatSession } from "@/types/agent";

/**
 * Whether this session could retry at all — agent, connection and status only.
 *
 * O(1) and allocation-free on purpose. The transcript evaluates it inside a
 * store selector, so it runs on every store write (every streaming delta);
 * anything that walked `messages` here would be quadratic across a long
 * thread's stream. Whether a given ROW is the retryable one is the
 * transcript's separate, memoized question.
 *
 * # Why a capability rather than an agent check
 *
 * THE canonical statement of this; everything else points here. Rewinding is
 * the engine's own `thread/rollback`, which is not an ACP verb. ACP's session
 * capabilities in schema 1.5.0 are `list`, `delete`, `additional_directories`,
 * `fork`, `resume`, `close` and `meta` — none of which tells an agent to
 * forget a turn. So for an ACP agent the choice is between hiding the
 * affordance and faking it with an append-and-resend that looks like a retry
 * and is not one; Atlas hides it.
 *
 * That still leaves HOW the caller knows. Comparing against the native agent's
 * id would work today and is exactly the special-casing ADR-0002 rules out, so
 * `agentSupportsRewind` comes from the connection answering for itself —
 * `AgentConnection::supports_rewind`, published onto the catalog entry as
 * `supportsRewind` — and this function only reads it. Note the honest limit:
 * the native connection answers `true` from its own impl rather than from
 * anything an agent advertised at `initialize`, because there is no ACP
 * capability to advertise. The seam is what matters here — an agent that gains
 * a rewind implements the trait and is offered the affordance, and no code
 * outside its own crate names it.
 *
 * @param agentSupportsRewind `agentCatalogEntry(agentType)?.supportsRewind`.
 *   False before the agent's first handshake, which is correct: unknown is not
 *   a licence to offer a destructive action.
 */
export function sessionCanRetry(
  session: ChatSession | undefined,
  agentSupportsRewind: boolean,
): boolean {
  if (!session) return false;
  if (!agentSupportsRewind) return false;
  if (session.disconnected || session.resumePending) return false;
  // `isBusyAgentStatus` rather than a status set of our own: it also covers
  // `waiting`, the turn that is paused on a permission or plan approval.
  // Rewinding there would drop the exchange out from under a modal the user
  // is still looking at. `stopping` is the same argument for a cancelled turn
  // whose terminal delta has not landed yet.
  return !isBusyAgentStatus(session.status) && !session.stopping;
}
