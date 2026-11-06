// Turning an ACP model id into something worth putting on screen.
//
// The agents advertise `{ id, name }` pairs and we store only the id, because
// the id is what `session/set_model` takes. That is fine for the wire and wrong
// for the reader: Claude Code's id is the literal string `default`, so the
// transcript header read "default" where a model name belongs.
//
// Resolution happens ONCE, when the label is stamped onto a message at turn end
// — not at render time. A transcript row must not look up live session state to
// decide what it says, or a later model switch silently relabels history.

import { loadCachedAcpModels } from "./acp-models-cache";
import type { SessionModeInfo } from "@/types/agents";

/** Some agents advertise bare lowercase names ("opus"), and an unlisted
 *  model falls back to its raw id; a name on screen starts with a capital. */
export function capitalizeModelName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Claude Code advertises its default model as "Recommended"; show "Default". */
export function modelLabel(m: { id: string; name: string }): string {
  if (m.name.trim().toLowerCase() === "recommended" || m.id === "default") return "Default";
  return capitalizeModelName(m.name);
}

/**
 * Display name for a model id, resolved against what the agent advertised.
 *
 * Falls back to the persisted per-agent cache for the same reason the composer's
 * picker does: ACP `session/load` doesn't re-advertise models, so a resumed
 * session can hold an empty list while the agent still has one. Falls back to
 * the raw id last — an unrecognised id is better than no label at all.
 */
export function resolveModelLabel(
  modelId: string | undefined,
  agentType: string | undefined,
  available: SessionModeInfo[] | undefined,
): string | undefined {
  if (!modelId) return undefined;
  const list =
    available && available.length > 0
      ? available
      : (loadCachedAcpModels(agentType ?? "atlas-agent")?.availableModels ?? []);
  const hit = list.find((m) => m.id === modelId);
  return hit ? modelLabel(hit) : capitalizeModelName(modelId);
}
