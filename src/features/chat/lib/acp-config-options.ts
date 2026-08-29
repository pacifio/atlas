// Agent-advertised session config options (P2.2 of
// `plans/atlas-acp-parity-loop.md`).
//
// ACP lets an agent advertise arbitrary knobs — a thinking-level select, a
// "web search" boolean, whatever it wants — through `session/new`'s
// `configOptions` and keeps them current via `config_options_updated`. Atlas
// only ever read `category: "model"` out of that list (and normalised
// `"mode"`), so every other knob an agent offered was invisible and unsettable.
//
// This projects the raw JSON into something the composer can render. Kept pure
// and separate from the component so the filtering rules — which are the part
// with actual judgement in them — are testable without a DOM.

import type { SessionModeInfo } from "@/types/agents";

/** One selectable value in a select knob. */
type Choice = { id: string; name: string; description: string | null };

/** A knob the composer can render. */
export type AcpConfigOption =
  | {
      kind: "boolean";
      id: string;
      name: string;
      description: string | null;
      value: boolean;
    }
  | {
      kind: "select";
      id: string;
      name: string;
      description: string | null;
      currentValue: string;
      choices: Choice[];
    };

/** Categories that already have their own dedicated composer surface.
 *
 *  `mode` and `model` are normalised into the mode/model pickers upstream — the
 *  model one by `model_select_of` in `atlas-agent-servers`, and here by
 *  {@link modelSelectOf} for the live delta — so surfacing them again as generic
 *  knobs would give the user two controls for one setting that could disagree.
 *
 *  This filter is load-bearing in both directions: whoever excludes a category
 *  here owes it a picker somewhere else. When the port dropped the upstream
 *  model normalisation and left this filter in place, model selection vanished
 *  from both surfaces at once.
 *
 *  `model` now holds that bargain exactly — the filter and {@link modelSelectOf}
 *  test the same predicate, so an option is in the pill xor in the knobs.
 *  `mode` does NOT: the mode pill is fed by ACP's separate `modes` wire
 *  (`AgentSessionModes`), which never looks at config options, so an agent that
 *  expresses its modes ONLY as a `category: "mode"` select still falls through
 *  both. That is the same hole one category over, and it is not fixed here. */
const OWNED_ELSEWHERE = new Set(["mode", "model"]);

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The choices of a select option, or `null` if this is not a usable select.
 *
 *  The wire flattens the kind onto the option: `{ type: "select", currentValue,
 *  options }`, per `SessionConfigKind`'s `#[serde(tag = "type")]`. `type` is
 *  authoritative when present; a missing one is sniffed from the payload, since
 *  the enum is `#[non_exhaustive]` and an unknown `type` must not be guessed
 *  into a control the agent did not offer. */
function selectOf(o: Record<string, unknown>): { currentValue: string; choices: Choice[] } | null {
  const type = str(o.type);
  if (type !== null && type !== "select") return null;
  if (type === null && o.options === undefined) return null;
  const choices = parseChoices(o.options);
  // A select with nothing to pick is a dead control — drop it rather than
  // rendering a menu that opens onto nothing.
  if (choices.length === 0) return null;
  return { currentValue: str(o.currentValue) ?? "", choices };
}

function booleanOf(o: Record<string, unknown>): { value: boolean } | null {
  const type = str(o.type);
  if (type !== null && type !== "boolean") return null;
  if (type === null && typeof o.currentValue !== "boolean") return null;
  return { value: o.currentValue === true };
}

/** Parse the raw `configOptions` blob into renderable knobs.
 *
 *  Tolerant by design: the shape is `#[non_exhaustive]` on the Rust side and
 *  the whole feature is unstable, so a malformed or unrecognised entry is
 *  skipped rather than failing the list — one bad option must not blank the
 *  composer's controls.
 */
export function parseConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpConfigOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name) continue;
    // A category is only "owned elsewhere" when the surface that owns it can
    // actually render THIS option. Both dedicated pickers are selects, so a
    // model- or mode-category knob of any other kind belongs to nobody —
    // skipping it here would make it invisible AND unsettable, which is the
    // very failure this filter caused for model selection.
    const category = str(o.category);
    if (category && OWNED_ELSEWHERE.has(category) && selectOf(o)) continue;
    const description = str(o.description);

    const boolean = booleanOf(o);
    if (boolean) {
      out.push({ kind: "boolean", id, name, description, value: boolean.value });
      continue;
    }
    const select = selectOf(o);
    if (select) {
      out.push({
        kind: "select",
        id,
        name,
        description,
        currentValue: select.currentValue,
        choices: select.choices,
      });
    }
  }
  return out;
}

/** The model picker an agent advertises, out of the same config-option blob.
 *
 *  ACP has no `models` field on a session: an agent that lets the client choose
 *  a model says so with a `category: "model"` select. The backend already
 *  projects that into the session snapshot, but the snapshot is only read at
 *  bind time — this is the live path, so a model changed INSIDE the agent (its
 *  own `/model`) moves the pill too.
 *
 *  `null` means this agent offers no model selection, which is a real answer:
 *  the pill hides. Gating is on the advertised category, never on which agent
 *  it is (ADR-0002). */
export function modelSelectOf(
  raw: unknown,
): { currentModel: string | null; availableModels: SessionModeInfo[] } | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (str(o.category) !== "model") continue;
    const select = selectOf(o);
    if (!select) continue;
    return {
      currentModel: select.currentValue || null,
      availableModels: select.choices.map((choice) => ({
        id: choice.id,
        name: choice.name,
        description: choice.description ?? undefined,
      })),
    };
  }
  return null;
}

/** `options` is either a flat array of choices or an array of groups, each with
 *  its own `options` (`SessionConfigSelectOptions` is untagged, so the two are
 *  told apart by shape). Groups are flattened: the composer's popover is a
 *  single list, and inventing a nested menu for it would be a new visual
 *  pattern. */
function parseChoices(raw: unknown): Choice[] {
  const flat: Choice[] = [];
  const push = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    const id = str(e.id) ?? str(e.value);
    const name = str(e.name) ?? id;
    if (!id || !name) return;
    flat.push({ id, name, description: str(e.description) });
  };
  if (!Array.isArray(raw)) return flat;
  for (const entry of raw) {
    const nested = (entry as Record<string, unknown> | null)?.options;
    if (Array.isArray(nested)) nested.forEach(push);
    else push(entry);
  }
  return flat;
}
