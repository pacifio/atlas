// Agent-advertised session config options (P2.2 of
// `plans/atlas-acp-parity-loop.md`).
//
// ACP lets an agent advertise arbitrary knobs — a thinking-level select, a
// "web search" boolean, whatever it wants — through `session/new`'s
// `configOptions` and keeps them current via `config_option_update`. Atlas only
// ever read `category: "model"` out of that list (and normalised `"mode"`), so
// every other knob an agent offered was invisible and unsettable.
//
// This projects the raw JSON into something the composer can render. Kept pure
// and separate from the component so the filtering rules — which are the part
// with actual judgement in them — are testable without a DOM.

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
      choices: { id: string; name: string; description: string | null }[];
    };

/** Categories that already have their own dedicated composer surface.
 *
 *  `mode` and `model` are normalised into the mode/model pickers upstream (see
 *  `NewSessionInfo::from`), so surfacing them again here would give the user two
 *  controls for one setting that could disagree. */
const OWNED_ELSEWHERE = new Set(["mode", "model"]);

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
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
    const category = str(o.category);
    if (category && OWNED_ELSEWHERE.has(category)) continue;
    const description = str(o.description);

    // The wire nests the payload under the kind: `{ boolean: {...} }` or
    // `{ select: {...} }`.
    const boolean = o.boolean as Record<string, unknown> | undefined;
    if (boolean && typeof boolean === "object") {
      out.push({
        kind: "boolean",
        id,
        name,
        description,
        value: boolean.currentValue === true,
      });
      continue;
    }
    const select = o.select as Record<string, unknown> | undefined;
    if (select && typeof select === "object") {
      const choices = parseChoices(select.options);
      // A select with nothing to pick is a dead control — drop it rather than
      // rendering a menu that opens onto nothing.
      if (choices.length === 0) continue;
      out.push({
        kind: "select",
        id,
        name,
        description,
        currentValue: str(select.currentValue) ?? "",
        choices,
      });
    }
  }
  return out;
}

/** `options` is either a flat array or `{ groups: [{ options: [...] }] }`.
 *  Groups are flattened: the composer's popover is a single list, and inventing
 *  a nested menu for it would be a new visual pattern. */
function parseChoices(raw: unknown): { id: string; name: string; description: string | null }[] {
  const flat: { id: string; name: string; description: string | null }[] = [];
  const push = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    const id = str(e.id) ?? str(e.value);
    const name = str(e.name) ?? id;
    if (!id || !name) return;
    flat.push({ id, name, description: str(e.description) });
  };
  if (Array.isArray(raw)) {
    raw.forEach(push);
    return flat;
  }
  if (raw && typeof raw === "object") {
    const groups = (raw as Record<string, unknown>).groups;
    if (Array.isArray(groups)) {
      for (const g of groups) {
        const opts = (g as Record<string, unknown>)?.options;
        if (Array.isArray(opts)) opts.forEach(push);
      }
    }
  }
  return flat;
}

/** The label for a select's current choice, falling back to the raw id. */
export function currentChoiceLabel(option: AcpConfigOption): string {
  if (option.kind === "boolean") return option.value ? "On" : "Off";
  return (
    option.choices.find((c) => c.id === option.currentValue)?.name ?? (option.currentValue || "—")
  );
}
