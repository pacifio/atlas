// Pure helpers over the ACP `config_options` wire shape (see `AcpConfigOption`
// in types/agents.ts for the field-name gotchas). Extracted from the composer
// so the matching rules — which decide whether a picker exists at all — are
// unit-testable without mounting the component tree.

import type { AcpConfigOption } from "@/types/agents";

/** Mode/option names arrive verbatim from the agent — OpenCode sends lowercase
 *  ids as names ("build", "plan"). Title-case a single all-lowercase word for
 *  display; multi-word or already-cased names (Claude's "Accept Edits") pass
 *  through. */
export function displayModeName(name: string): string {
  return /^[a-z][a-z0-9-]*$/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** Whether an option is the agent's reasoning-effort control.
 *
 *  Matched on ACP's `category` (the SEMANTIC field) before falling back to the
 *  id, because the id is agent-specific: codex-acp calls it
 *  `reasoning_effort`, claude-agent-acp calls it `effort` — both categorise it
 *  `thought_level`. An id-only match is exactly how codex's picker would go
 *  missing while claude's worked. */
export function isEffortOption(opt: AcpConfigOption): boolean {
  const key = (opt.category ?? opt.id).toLowerCase();
  return key === "thought_level" || key === "effort";
}

/** A select option's choices (ACP `options: [{ value, name }]`). */
export function optionValues(opt: AcpConfigOption): { id: string; label: string }[] {
  return (opt.options ?? [])
    .filter((v) => !!v.value)
    .map((v) => ({ id: v.value, label: v.name ?? v.value }));
}

export function optionValue(opt: AcpConfigOption): string | boolean | undefined {
  return opt.currentValue ?? undefined;
}

/** Label for an option's current state, falling back to the option's name. */
export function optionLabel(opt: AcpConfigOption): string {
  const cur = optionValue(opt);
  if (typeof cur === "boolean") return `${opt.name ?? opt.id}: ${cur ? "On" : "Off"}`;
  const match = optionValues(opt).find((v) => v.id === cur);
  return displayModeName(match?.label ?? (typeof cur === "string" ? cur : (opt.name ?? opt.id)));
}
