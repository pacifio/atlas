import type { UpdateOutcome } from "./atlas-config-api";

/**
 * The one write path to `config.toml`, shared by the settings and keybinding
 * editors, and the one place its generation counter lives.
 *
 * Rust refuses a patch computed against a stale generation and hands back the
 * current one instead (see `atlas-config-api.ts`). A generation can go stale
 * with no UI involvement at all — an internal Rust-side write (the Local Model
 * Manager persisting a model switch), or an external edit — so a conflict does
 * NOT mean someone else wanted this same key. It means the base is out of
 * date, and the answer is to adopt the fresh generation and re-send.
 *
 * Only after [`CONFIG_WRITE_ATTEMPTS`] consecutive conflicts is it a real
 * sustained race worth telling the user about. A single retry wasn't enough:
 * during a burst of rapid changes — dragging the zoom slider, say — a second
 * unrelated write can land between the retry and its read, silently dropping
 * the user's action.
 *
 * The counter is module state rather than a field of some store because it
 * describes the file, not any one editor of it: two stores mirroring their own
 * copy is precisely how one of them would start writing against a generation
 * the other already retired.
 */
export const CONFIG_WRITE_ATTEMPTS = 3;

let generation = 0;

/** Adopt the generation from anything that carries one: the boot payload, a
 *  hot reload, or a write's reply. */
export function setConfigGeneration(next: number): void {
  generation = next;
}

export function configGeneration(): number {
  return generation;
}

/**
 * Send a patch until it applies or the attempts run out, keeping the
 * generation current throughout.
 *
 * Resolves with the final outcome — `conflict` meaning "gave up", which the
 * caller reports; rejects only if the IPC call itself failed.
 */
export async function commitConfigPatch(
  send: (generation: number) => Promise<UpdateOutcome>,
): Promise<UpdateOutcome> {
  for (let attempt = CONFIG_WRITE_ATTEMPTS; attempt > 0; attempt--) {
    const outcome = await send(generation);
    setConfigGeneration(outcome.generation);
    if (outcome.kind === "applied" || attempt === 1) return outcome;
  }
  throw new Error("unreachable: the loop returns on its last attempt");
}
