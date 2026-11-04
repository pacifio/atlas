// Settings → Skills, the derivations behind both lists and every dialog. Pure:
// no React, no IPC. The containers fetch, these shape, the views render.

import type { ComponentKind, InstalledPack, Pack, PackSearchHit } from "@/features/packs/lib/types";
import type { ProjectionStatus, ReconciledSkill, ReconcileView, Scope, ToolInfo } from "./types";

/** One skill as a dialog lists it. */
export interface ModalSkill {
  name: string;
  description?: string | null;
}

/** Singular, for Discover's "{n} {kind}" chips (the chip adds the plural "s"). */
export const MARKET_KIND_LABEL: Record<ComponentKind, string> = {
  skill: "skill",
  agent: "agent",
  command: "command",
  hook: "hook",
  rule: "rule",
  script: "script",
};

/** Plural, for an installed pack's summary; `kindCounts` drops the "s" for one. */
export const PACK_KIND_LABEL: Record<ComponentKind, string> = {
  skill: "skills",
  agent: "agents",
  command: "commands",
  hook: "hooks",
  rule: "rules",
  script: "scripts",
};

/** "2 commands · 1 hook", in the order the kinds first appear. */
export function kindCounts(components: { kind: ComponentKind }[]): string {
  const m = new Map<ComponentKind, number>();
  for (const c of components) m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
  return [...m.entries()]
    .map(([k, n]) => `${n} ${n === 1 ? PACK_KIND_LABEL[k].slice(0, -1) : PACK_KIND_LABEL[k]}`)
    .join(" · ");
}

/** Apply the per-tool optimistic overrides (toolId → on) on top of a projected
 *  set, so a pack toggle reflects instantly before the disk reconcile lands. */
export function mergeOptimistic(
  base: Set<string>,
  optimistic: Record<string, boolean>,
): Set<string> {
  const next = new Set(base);
  for (const [toolId, on] of Object.entries(optimistic)) {
    if (on) next.add(toolId);
    else next.delete(toolId);
  }
  return next;
}

// ── Discover ───────────────────────────────────────────────────────────────

/** Merge the seed searches behind "Popular": one entry per id, keeping the
 *  highest install count, most installed first. */
export function mergePopular(batches: PackSearchHit[][]): PackSearchHit[] {
  const byId = new Map<string, PackSearchHit>();
  for (const batch of batches) {
    for (const hit of batch) {
      const prev = byId.get(hit.id);
      if (!prev || hit.installs > prev.installs) byId.set(hit.id, hit);
    }
  }
  return [...byId.values()].sort((a, b) => b.installs - a.installs);
}

export interface SkillDetail {
  manifestDescription: string | null;
  skills: ModalSkill[];
  /** Counts of the non-skill components, per kind, in first-seen order. */
  otherCounts: [ComponentKind, number][];
}

/** What a registry hit's dialog shows from the repo preview. Packs rarely carry
 *  a manifest description but the skills inside them do, so those are listed;
 *  the other kinds (commands, agents, rules) are counts. */
export function detailFromPreview(preview: Pack | null): SkillDetail {
  const components = preview?.components ?? [];
  const skills = components
    .filter((c) => c.kind === "skill")
    .map((c) => ({ name: c.name, description: c.description }));
  const counts = new Map<ComponentKind, number>();
  for (const c of components)
    if (c.kind !== "skill") counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return {
    manifestDescription: preview?.manifest?.description || null,
    skills,
    otherCounts: [...counts.entries()],
  };
}

export const githubUrlFor = (source: string) => `https://github.com/${source}`;

/** "Copy as Markdown" for a registry hit: its name, the preview's description
 *  and skills when there is one, and the repo link. */
export function hitMarkdown(hit: PackSearchHit, preview: Pack | null): string {
  const lines = [`# ${hit.name}`, ""];
  if (preview?.manifest?.description) lines.push(preview.manifest.description, "");
  lines.push(...skillSections(detailFromPreview(preview).skills));
  lines.push(`Source: ${githubUrlFor(hit.source)}`);
  return lines.join("\n");
}

// ── Installed ──────────────────────────────────────────────────────────────

/** "Copy as Markdown" for an installed pack: its name, its skills, the repo. */
export function packMarkdown(pack: InstalledPack, skills: ModalSkill[]): string {
  const lines = [`# ${pack.pack.name}`, ""];
  lines.push(...skillSections(skills));
  lines.push(`Source: ${githubUrlFor(pack.source)}`);
  return lines.join("\n");
}

function skillSections(skills: ModalSkill[]): string[] {
  const lines: string[] = [];
  for (const s of skills) {
    lines.push(`## ${s.name}`);
    if (s.description) lines.push("", s.description);
    lines.push("");
  }
  return lines;
}

/** The Installed list: packs that ship no skills first (so they don't vanish),
 *  then every installed skill by its real name, sorted. */
export function installedLists(
  view: ReconcileView | null,
  packList: InstalledPack[],
): { packsNoSkills: InstalledPack[]; skills: ReconciledSkill[] } {
  const all = view?.skills ?? [];
  return {
    packsNoSkills: packList.filter((p) => !all.some((s) => s.pack === p.pack.name)),
    skills: [...all].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Where a skill came from, in the row's status line. */
export function skillOrigin(skill: ReconciledSkill): string {
  return skill.pack
    ? `From ${skill.pack}`
    : skill.managed
      ? "Your skill"
      : "Found in an agent's folder";
}

/** The tools a skill is delivered to in `scope`, by display name. */
export function deliveredToolNames(
  skill: ReconciledSkill,
  tools: ToolInfo[],
  scope: Scope,
): string[] {
  return skill.cells
    .filter((c) => c.scope === scope && (c.status === "synced" || c.status === "pack"))
    .map((c) => tools.find((t) => t.id === c.tool)?.displayName ?? c.tool);
}

/** A skill's status in one tool. An optimistic override wins over the disk. */
export function skillToolStatus(
  skill: ReconciledSkill,
  toolId: string,
  scope: Scope,
  optimistic: Record<string, boolean>,
): ProjectionStatus {
  const ov = optimistic[toolId];
  if (ov !== undefined) return ov ? "synced" : "absent";
  return skill.cells.find((c) => c.tool === toolId && c.scope === scope)?.status ?? "absent";
}
