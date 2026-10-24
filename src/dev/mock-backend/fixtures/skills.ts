// Settings → Skills (Installed + Discover) and Settings → Agents (the ACP
// registry marketplace), plus the agent catalog every other agent surface
// reads.
//
// Disk is the state for all of this in Rust: every mutation is written to the
// skills store / installed map and the panel refetches rather than patching
// locally. The fakes keep that contract — the module-level `installedSkills` /
// `installedPacks` / `registry` / `catalog` below ARE the disk, so projecting a
// skill, installing a pack or removing an agent actually changes what the next
// `skills_reconcile` / `pack_list` / `acp_registry_list` returns. Without that
// every toggle in those panels would snap back on the refetch that follows it.
//
// Two of these supersede the empty stubs `scenarios/base.ts` used to carry:
// `agents_catalog` and `acp_registry_list`. Empty listings left the marketplace
// grid, the composer's featured-agent offers and the skills tool matrix with
// nothing to draw, which is exactly the part worth looking at.
//
// Per ADR-0002 no agent is special-cased: the native agent is one catalog entry
// among the installed externals and the PATH detections, distinguished only by
// `kind: "native"` / `source: "in-process"` the way Rust distinguishes it.

import type {
  AcpRegistryEntry,
  AcpRegistryListing,
} from "@/features/agents/lib/agent-registry-api";
import type {
  ComponentKind,
  InstalledPack,
  Pack,
  PackComponent,
  PackInstallResult,
  PackProjectReport,
  PackProjectionView,
  PackSearchHit,
  PackUpdateCheck,
} from "@/features/packs/lib/types";
import type {
  AgentTarget,
  PackComponentMeta,
  ProjectionCell,
  ProjectionStatus,
  ReconciledSkill,
  ReconcileView,
  Scope,
  SkillContent,
  SkillMeta,
  ToolInfo,
} from "@/features/skills/lib/types";
import type { AgentCatalog, AgentCatalogEntry } from "@/types/agent-catalog";
import type { AgentConfigPatch } from "@/features/agents/lib/agent-config-api";
import type { TypedHandlers, Unit, Unread } from "../types";
import { MOCK_PROJECT } from "../project";

const HOME = "/Users/dev";
const PROJECT = MOCK_PROJECT.path;
/** Fixed "now", so install dates and refresh times never move between reloads. */
const NOW = Date.parse("2026-09-18T11:30:00Z");

const asScope = (value: unknown): Scope => (value === "project" ? "project" : "global");

// ── Tools ───────────────────────────────────────────────────────────────────
// The Rust registry is exactly these three (`TOOL_REGISTRY` in skills.rs), and
// their ids are what every projection command takes. Codex is deliberately
// undetected at project scope: that is the only way to see the "n/a" row in the
// per-tool toggles, and it is the common real case (no `.codex` in the repo).

const TOOLS: ToolInfo[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    detectedGlobal: true,
    detectedProject: true,
    supportsSymlink: true,
    delivery: "native-dir",
  },
  {
    id: "codex",
    displayName: "Codex",
    detectedGlobal: true,
    detectedProject: false,
    supportsSymlink: true,
    delivery: "native-dir",
  },
  {
    id: "atlas",
    displayName: "Atlas",
    detectedGlobal: true,
    detectedProject: true,
    supportsSymlink: true,
    delivery: "native-dir",
  },
];

const detectedIn = (tool: ToolInfo, scope: Scope) =>
  scope === "project" ? tool.detectedProject : tool.detectedGlobal;

const SKILLS_DIR: Record<string, Record<Scope, string>> = {
  "claude-code": { global: `${HOME}/.claude/skills`, project: `${PROJECT}/.claude/skills` },
  codex: { global: `${HOME}/.codex/skills`, project: `${PROJECT}/.agents/skills` },
  atlas: { global: `${HOME}/.atlas/agent-skills`, project: `${PROJECT}/.atlas/agent-skills` },
};

function targets(scope: Scope): AgentTarget[] {
  return TOOLS.map((tool) => ({
    id: tool.id,
    displayName: tool.displayName,
    skillsDir: SKILLS_DIR[tool.id][scope],
    delivery: tool.delivery,
    detected: detectedIn(tool, scope),
  }));
}

// ── Skill bodies ────────────────────────────────────────────────────────────
// `skills_read` feeds a markdown renderer, so every body carries the four
// constructs that renderer can get wrong — YAML front matter it must strip, a
// heading hierarchy, a fenced code block and a table — rather than one
// paragraph of lorem.

function skillMarkdown(
  name: string,
  description: string,
  overview: string,
  snippet: string,
): { raw: string; body: string } {
  const body = `# ${name}

${overview}

## When to use it

- The user asks for it by name, or names the workflow it owns.
- A change touches the files listed under **Scope** below.

## Steps

1. Read the affected files before proposing an edit.
2. Make the smallest change that satisfies the request.
3. Run the verification command and paste its output back.

\`\`\`bash
${snippet}
\`\`\`

## Reference

| Option | Default | What it changes |
| --- | --- | --- |
| \`--scope\` | \`global\` | Where the skill is read from. |
| \`--dry-run\` | \`false\` | Prints the plan without writing anything. |
| \`--verbose\` | \`false\` | Echoes every file the skill touched. |

> Skills are instructions, not code: nothing here runs on its own.
`;
  return {
    raw: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    body,
  };
}

// ── Skills ──────────────────────────────────────────────────────────────────

interface MockSkill {
  name: string;
  description: string;
  scope: Scope;
  /** Lives in Atlas's canonical store — `false` is an external skill Atlas only
   *  found, which is what the "Make for all agents" adopt flow acts on. */
  managed: boolean;
  /** Owning pack, when a pack provided this skill. Its cells are derived from
   *  the pack's projections rather than stored, so the Packs tab stays the one
   *  place that can move them. */
  pack: string | null;
  /** Per-tool projection, at this skill's own scope. A tool that is absent from
   *  the record has no projection at all. */
  cells: Record<string, { status: ProjectionStatus; mode: "symlink" | "copy" | null }>;
  overview: string;
  snippet: string;
}

type Cell = MockSkill["cells"][string];

/** Functions, not shared constants: `skills_freeze` rewrites `mode` in place,
 *  and one aliased object would freeze every skill that borrowed it. */
const synced = (): Cell => ({ status: "synced", mode: "symlink" });
/** Frozen: the symlink was replaced by a real copy, so uninstalling Atlas can't
 *  take the skill with it. */
const frozen = (): Cell => ({ status: "synced", mode: "copy" });

let installedSkills: MockSkill[] = [
  {
    name: "code-review",
    description:
      "Review a diff against this repo's documented standards and the originating issue.",
    scope: "global",
    managed: true,
    pack: null,
    cells: { "claude-code": synced(), codex: synced(), atlas: synced() },
    overview: "Reviews changes along two axes: standards and spec.",
    snippet: "git diff --stat $(git merge-base HEAD main)..HEAD",
  },
  {
    name: "commit-messages",
    description: "Write conventional-commit subjects from a staged diff.",
    scope: "global",
    managed: true,
    pack: null,
    cells: { "claude-code": synced() },
    overview: "One subject line, one scope, no attribution footers.",
    snippet: "git diff --cached",
  },
  {
    // Nothing projected anywhere: the "off" row, and the state a freshly
    // installed skill sits in until the user picks a tool for it.
    name: "pdf-forms",
    description: "Fill and flatten AcroForm PDFs without rasterising the page.",
    scope: "global",
    managed: true,
    pack: null,
    cells: {},
    overview: "Reads the field dictionary first; never re-renders the page.",
    snippet: "python -m pypdf --list-fields form.pdf",
  },
  {
    // Edited inside the agent's own skills dir after Atlas projected it — the
    // copy's hash no longer matches canonical, so the toggle needs `force`.
    name: "changelog-writer",
    description: "Turn merged PR titles into a release changelog grouped by area.",
    scope: "global",
    managed: true,
    pack: null,
    cells: { "claude-code": synced(), codex: { status: "drifted", mode: "copy" } },
    overview: "Groups by area, then by breaking/feature/fix.",
    snippet: "gh pr list --state merged --limit 50 --json title,labels",
  },
  {
    // Frozen everywhere: both projections are real copies rather than symlinks.
    name: "spreadsheet-analysis",
    description: "Answer questions about an .xlsx without opening Excel.",
    scope: "global",
    managed: true,
    pack: null,
    cells: { "claude-code": frozen(), codex: frozen() },
    overview: "Reads sheets as frames; keeps formulas out of the answer.",
    snippet: "python -c \"import pandas as pd; print(pd.read_excel('book.xlsx').head())\"",
  },
  {
    // The long-name case. Names come from a directory on disk, so nothing
    // truncates them at the source — the table has to.
    name: "enterprise-incident-postmortem-and-remediation-playbook",
    description:
      "Run a blameless postmortem end to end: assemble the timeline from the incident channel and the deploy log, separate the trigger from the contributing conditions, draft the customer-facing summary, and file one remediation issue per contributing condition with an owner and a date already attached.",
    scope: "global",
    managed: true,
    pack: null,
    cells: { "claude-code": synced() },
    overview: "Timeline first, cause second, remediation last — never the other way round.",
    snippet: "atlas log --since '48 hours ago' --source system",
  },
  {
    // Adopted: was external, "Make for all agents" copied it into the canonical
    // store and symlinked it everywhere detected.
    name: "screenshot-annotate",
    description: "Annotate a screenshot with numbered callouts and a caption block.",
    scope: "global",
    managed: true,
    pack: null,
    cells: { "claude-code": synced(), codex: synced(), atlas: synced() },
    overview: "Callouts are numbered in reading order, not in click order.",
    snippet: "sips -g pixelWidth -g pixelHeight shot.png",
  },
  {
    // External: a real directory inside Claude Code's skills dir that Atlas did
    // not author. The adopt affordance exists for exactly this row.
    name: "legacy-jira-triage",
    description: "Triage an inbound Jira ticket into the right component and priority.",
    scope: "global",
    managed: false,
    pack: null,
    cells: { "claude-code": { status: "external", mode: null } },
    overview: "Prefers the component owner's own wording over the reporter's.",
    snippet: "jira issue list --plain --columns key,summary,status",
  },
  {
    // Name collision: an external skill of the same name exists under Codex and
    // its content differs, so the cell is read-only until a human resolves it.
    name: "release-notes",
    description: "Draft release notes from the commits between two tags.",
    scope: "global",
    managed: true,
    pack: null,
    cells: { "claude-code": synced(), codex: { status: "conflict", mode: "copy" } },
    overview: "Reads tags, not branches; ignores merge commits.",
    snippet: "git log --no-merges --pretty='%s' v0.3.0..v0.3.1",
  },
  {
    name: "react-performance",
    description: "Find and fix avoidable re-renders in a React tree.",
    scope: "global",
    managed: false,
    pack: "frontend-toolkit",
    cells: {},
    overview: "Measures before it edits; a memo without a profile is a guess.",
    snippet: "bunx react-scan ./src",
  },
  {
    name: "design-system-audit",
    description: "Check a component against the design system's tokens and spacing scale.",
    scope: "global",
    managed: false,
    pack: "frontend-toolkit",
    cells: {},
    overview: "Hardcoded hex values are the finding; the token is the fix.",
    snippet: "rg '#[0-9a-fA-F]{6}' src/features --glob '!*.test.*'",
  },
  {
    name: "postgres-query-plans",
    description: "Read an EXPLAIN ANALYZE plan and name the one node that costs the query.",
    scope: "global",
    managed: false,
    pack: "data-ops-collection",
    cells: {},
    overview: "Actual rows versus estimated rows, every time, before anything else.",
    snippet: "psql -c 'EXPLAIN (ANALYZE, BUFFERS) SELECT …'",
  },

  // ── project scope ────────────────────────────────────────────────────────
  {
    name: "acme-api-conventions",
    description: "The /v2 endpoint conventions this repo actually follows, with the exceptions.",
    scope: "project",
    managed: true,
    pack: null,
    cells: { "claude-code": synced(), atlas: synced() },
    overview: "Written from the endpoints that exist, not from the RFC they cite.",
    snippet: "rg 'router\\.(get|post|put)' src/server --line-number",
  },
  {
    name: "acme-release-checklist",
    description: "The pre-release gate list for this project, in the order it has to run.",
    scope: "project",
    managed: true,
    pack: null,
    cells: {},
    overview: "Every item names the command that proves it, or it is not an item.",
    snippet: "bun run lint && bun run typecheck && bun run test",
  },
  {
    name: "acme-storybook-stories",
    description: "Write a story per visual state, including the empty and error ones.",
    scope: "project",
    managed: false,
    pack: null,
    cells: { "claude-code": { status: "external", mode: null } },
    overview: "A state without a story is a state nobody has looked at.",
    snippet: "bun run storybook",
  },
  {
    name: "sql-tuning",
    description: "Rewrite a slow query without changing the rows it returns.",
    scope: "project",
    managed: false,
    pack: "data-ops-collection",
    cells: {},
    overview: "Proves equivalence with a row-count diff before proposing the rewrite.",
    snippet: "psql -f before.sql > before.txt && psql -f after.sql > after.txt",
  },
];

const skillPath = (skill: MockSkill): string =>
  skill.managed
    ? `${skill.scope === "project" ? PROJECT : HOME}/.atlas/skills/${skill.name}/SKILL.md`
    : `${skill.scope === "project" ? PROJECT : HOME}/.claude/skills/${skill.name}/SKILL.md`;

/** Tools a pack is currently projected into, at one scope. */
function packTools(scope: Scope, packName: string): string[] {
  return installedPacks.find((p) => p.scope === scope && p.pack.name === packName)?.tools ?? [];
}

/** The tool ids a skill is live in — symlink (or frozen copy) present. A
 *  pack-provided skill inherits its pack's projections, so the Packs tab stays
 *  the only place that can move it. */
function enabledAgentsOf(skill: MockSkill): string[] {
  if (skill.pack) return packTools(skill.scope, skill.pack);
  return Object.entries(skill.cells)
    .filter(([, cell]) => cell.status === "synced")
    .map(([tool]) => tool);
}

function metaOf(skill: MockSkill): SkillMeta {
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    enabledAgents: enabledAgentsOf(skill),
    path: skillPath(skill),
    delivery: "native-dir",
    managed: skill.managed,
    pack: skill.pack,
  };
}

function cellsOf(skill: MockSkill): ProjectionCell[] {
  const projected = skill.pack ? packTools(skill.scope, skill.pack) : [];
  return TOOLS.map((tool) => {
    if (skill.pack) {
      // The owning pack is named only where the projection actually exists —
      // it is what makes the cell read-only, so an absent cell must not claim it.
      const owned = projected.includes(tool.id);
      return {
        tool: tool.id,
        scope: skill.scope,
        status: owned ? "pack" : "absent",
        mode: owned ? "symlink" : null,
        pack: owned ? skill.pack : null,
      } satisfies ProjectionCell;
    }
    const cell = skill.cells[tool.id];
    return {
      tool: tool.id,
      scope: skill.scope,
      status: cell?.status ?? "absent",
      mode: cell?.mode ?? null,
    } satisfies ProjectionCell;
  });
}

function findSkill(scope: Scope, name: string): MockSkill {
  const skill = installedSkills.find((s) => s.scope === scope && s.name === name);
  if (!skill) throw new Error(`skill '${name}' was not found in ${scope} scope`);
  return skill;
}

// ── Packs ───────────────────────────────────────────────────────────────────

const component = (
  kind: ComponentKind,
  name: string,
  relPath: string,
  description: string | null,
): PackComponent => ({ kind, name, relPath, description });

interface MockPack {
  scope: Scope;
  pack: Pack;
  source: string;
  commit: string;
  installedAt: number;
  updatedAt: number;
  /** Tools this pack's components are projected into right now. */
  tools: string[];
  /** The source repo has moved on — what `pack_check_update` reports. */
  behind: boolean;
}

const FRONTEND_TOOLKIT: Pack = {
  name: "frontend-toolkit",
  root: `${HOME}/.atlas/packs/frontend-toolkit`,
  manifest: {
    name: "frontend-toolkit",
    version: "2.4.0",
    description: "Skills, commands and rules for a React + Tailwind codebase.",
    author: "Acme Labs",
  },
  components: [
    component(
      "skill",
      "react-performance",
      "skills/react-performance/SKILL.md",
      "Find and fix avoidable re-renders in a React tree.",
    ),
    component(
      "skill",
      "design-system-audit",
      "skills/design-system-audit/SKILL.md",
      "Check a component against the design system's tokens.",
    ),
    component("command", "ship", "commands/ship.md", "Run the release gates, then open the PR."),
    component(
      "command",
      "story",
      "commands/story.md",
      "Scaffold a Storybook story per visual state.",
    ),
    component(
      "agent",
      "a11y-reviewer",
      "agents/a11y-reviewer.md",
      "Audit a component for keyboard and screen-reader gaps.",
    ),
    component(
      "rule",
      "no-inline-hex",
      "rules/no-inline-hex.md",
      "Colors come from tokens, never from a literal.",
    ),
  ],
};

const DATA_OPS: Pack = {
  name: "data-ops-collection",
  root: `${HOME}/.atlas/packs/data-ops-collection`,
  manifest: {
    name: "data-ops-collection",
    version: "0.9.2",
    description: "Query tuning, migration review and warehouse hygiene.",
    author: "International Data Engineering Collective",
  },
  components: [
    component(
      "skill",
      "postgres-query-plans",
      "skills/postgres-query-plans/SKILL.md",
      "Read an EXPLAIN ANALYZE plan.",
    ),
    component(
      "skill",
      "sql-tuning",
      "skills/sql-tuning/SKILL.md",
      "Rewrite a slow query without changing its rows.",
    ),
    component(
      "command",
      "migrate",
      "commands/migrate.md",
      "Review a migration before it is applied.",
    ),
    component("rule", "no-select-star", "rules/no-select-star.md", "Name the columns you read."),
    component("script", "vacuum.sh", "scripts/vacuum.sh", null),
  ],
};

const RELEASE_ENGINEERING: Pack = {
  name: "release-engineering",
  root: `${HOME}/.atlas/packs/release-engineering`,
  manifest: {
    name: "release-engineering",
    version: "1.1.0",
    description: "Release automation: no skills, only commands, hooks and rules.",
    author: "Acme Labs",
  },
  components: [
    component(
      "command",
      "cut-release",
      "commands/cut-release.md",
      "Tag, build and draft the notes.",
    ),
    component("command", "rollback", "commands/rollback.md", "Revert to the previous tag safely."),
    component("hook", "pre-tag", "hooks/pre-tag.json", null),
    component(
      "rule",
      "version-branches",
      "rules/version-branches.md",
      "Feature PRs target the version branch.",
    ),
  ],
};

let installedPacks: MockPack[] = [
  {
    scope: "global",
    pack: FRONTEND_TOOLKIT,
    source: "acme-labs/frontend-toolkit",
    commit: "9f1c4ae7b25d0c3184f6a0b7c9e2d5138ab47f60",
    installedAt: NOW - 34 * 86_400_000,
    updatedAt: NOW - 6 * 86_400_000,
    tools: ["claude-code"],
    behind: false,
  },
  {
    // Long publisher name, and the one pack with an update waiting — the Check
    // for update → Update available → Updating… path needs a pack that is
    // genuinely behind, or that control only ever says "Up to date".
    scope: "global",
    pack: DATA_OPS,
    source: "international-data-engineering-collective/data-ops-collection",
    commit: "3b8e0d21f74c5a96ee1207b4d8f3a5c60912e7bd",
    installedAt: NOW - 61 * 86_400_000,
    updatedAt: NOW - 61 * 86_400_000,
    tools: ["claude-code", "codex"],
    behind: true,
  },
  {
    // Ships no skills at all, so it only appears as its own row in Installed —
    // the branch that used to drop packs from the list entirely.
    scope: "global",
    pack: RELEASE_ENGINEERING,
    source: "acme-labs/release-engineering",
    commit: "c40a7d9e1b6382f5a0c4e7d98b12356f0a4de8c1",
    installedAt: NOW - 12 * 86_400_000,
    updatedAt: NOW - 12 * 86_400_000,
    tools: [],
    behind: false,
  },
  {
    scope: "project",
    pack: { ...DATA_OPS, root: `${PROJECT}/.atlas/packs/data-ops-collection` },
    source: "international-data-engineering-collective/data-ops-collection",
    commit: "3b8e0d21f74c5a96ee1207b4d8f3a5c60912e7bd",
    installedAt: NOW - 9 * 86_400_000,
    updatedAt: NOW - 9 * 86_400_000,
    tools: ["claude-code"],
    behind: false,
  },
];

/** How one component kind lands in one tool. Codex takes no agents and nothing
 *  executes a script, so both are reported as skipped rather than projected —
 *  the per-component report exists to show exactly that. */
function projectionModeFor(tool: string, kind: ComponentKind): { mode: string; status: string } {
  if (kind === "script") return { mode: "unsupported", status: "skipped" };
  if (kind === "agent" && tool !== "claude-code") return { mode: "unsupported", status: "skipped" };
  if (kind === "hook") {
    return tool === "claude-code"
      ? { mode: "settings-merge", status: "projected" }
      : { mode: "unsupported", status: "skipped" };
  }
  if (kind === "rule" && tool === "codex") return { mode: "append", status: "projected" };
  return { mode: "symlink", status: "projected" };
}

const findPack = (scope: Scope, name: string): MockPack => {
  const pack = installedPacks.find((p) => p.scope === scope && p.pack.name === name);
  if (!pack) throw new Error(`pack '${name}' is not installed in ${scope} scope`);
  return pack;
};

// ── The skills.sh registry (Discover) ───────────────────────────────────────
// Search returns only {id, skillId, name, installs, source}; a description
// needs the repo clone `pack_remote_preview` does. Discover's default view
// merges the seed queries "agent", "react", "design", "review", "database" and
// "python", so every one of those has to match something here or the Popular
// table is empty on first paint.

const SEARCH_INDEX: PackSearchHit[] = [
  {
    id: "acme-labs/frontend-toolkit/react-performance",
    skillId: "react-performance",
    name: "react-performance",
    installs: 48_210,
    source: "acme-labs/frontend-toolkit",
  },
  {
    id: "acme-labs/frontend-toolkit/design-system-audit",
    skillId: "design-system-audit",
    name: "design-system-audit",
    installs: 31_884,
    source: "acme-labs/frontend-toolkit",
  },
  {
    id: "kavi/review-kit/code-review",
    skillId: "code-review",
    name: "code-review",
    installs: 127_402,
    source: "kavi/review-kit",
  },
  {
    id: "kavi/review-kit/pr-description",
    skillId: "pr-description",
    name: "pr-description",
    installs: 22_017,
    source: "kavi/review-kit",
  },
  {
    id: "international-data-engineering-collective/data-ops-collection/postgres-query-plans",
    skillId: "postgres-query-plans",
    name: "postgres-query-plans",
    installs: 9_640,
    source: "international-data-engineering-collective/data-ops-collection",
  },
  {
    id: "international-data-engineering-collective/data-ops-collection/sql-tuning",
    skillId: "sql-tuning",
    name: "sql-tuning",
    installs: 14_355,
    source: "international-data-engineering-collective/data-ops-collection",
  },
  {
    id: "hexbyte/db-lab/database-migrations",
    skillId: "database-migrations",
    name: "database-migrations",
    installs: 7_115,
    source: "hexbyte/db-lab",
  },
  {
    id: "mona/py-tools/python-typing-migration",
    skillId: "python-typing-migration",
    name: "python-typing-migration",
    installs: 18_903,
    source: "mona/py-tools",
  },
  {
    id: "mona/py-tools/pytest-flake-hunter",
    skillId: "pytest-flake-hunter",
    name: "pytest-flake-hunter",
    installs: 5_442,
    source: "mona/py-tools",
  },
  {
    id: "evalbench/agent-evals/agent-evals",
    skillId: "agent-evals",
    name: "agent-evals",
    installs: 26_780,
    source: "evalbench/agent-evals",
  },
  {
    id: "evalbench/agent-evals/agent-tracing",
    skillId: "agent-tracing",
    name: "agent-tracing",
    installs: 4_209,
    source: "evalbench/agent-evals",
  },
  {
    id: "lumen/design-notes/design-review",
    skillId: "design-review",
    name: "design-review",
    installs: 35_119,
    source: "lumen/design-notes",
  },
  {
    id: "lumen/design-notes/motion-audit",
    skillId: "motion-audit",
    name: "motion-audit",
    installs: 2_884,
    source: "lumen/design-notes",
  },
  {
    id: "acme-labs/release-engineering/release-notes",
    skillId: "release-notes",
    name: "release-notes",
    installs: 11_260,
    source: "acme-labs/release-engineering",
  },
  // A repo whose only skill has a name long enough to test the Skill column.
  {
    id: "ops-guild/incident-playbooks/enterprise-incident-postmortem-and-remediation-playbook",
    skillId: "enterprise-incident-postmortem-and-remediation-playbook",
    name: "enterprise-incident-postmortem-and-remediation-playbook",
    installs: 1_207,
    source: "ops-guild/incident-playbooks",
  },
];

/** What `pack_remote_preview` clones back, per source repo. Sources missing
 *  from here get a synthesized single-skill pack, except `PREVIEW_FAILS`. */
const PREVIEWS: Record<string, Pack> = {
  "acme-labs/frontend-toolkit": FRONTEND_TOOLKIT,
  "international-data-engineering-collective/data-ops-collection": DATA_OPS,
  "acme-labs/release-engineering": RELEASE_ENGINEERING,
  "kavi/review-kit": {
    name: "review-kit",
    root: "/tmp/atlas-preview/review-kit",
    manifest: {
      name: "review-kit",
      version: "3.0.1",
      description: "Code review, PR descriptions, and the checklists behind both.",
      author: "kavi",
    },
    components: [
      component(
        "skill",
        "code-review",
        "skills/code-review/SKILL.md",
        "Review a diff against documented standards and the originating issue.",
      ),
      component(
        "skill",
        "pr-description",
        "skills/pr-description/SKILL.md",
        "Write the PR body from the diff, not from the branch name.",
      ),
      component("command", "review", "commands/review.md", "Review everything since a merge-base."),
    ],
  },
};

/** One source that fails to clone — the detail modal's "Couldn't load details —
 *  you can still install." path, which nothing else reaches. */
const PREVIEW_FAILS = "ops-guild/incident-playbooks";

function previewOf(source: string): Pack {
  if (source === PREVIEW_FAILS) {
    throw new Error(`could not clone ${source}: repository not found (404)`);
  }
  const known = PREVIEWS[source];
  if (known) return known;
  const hit = SEARCH_INDEX.find((h) => h.source === source);
  const name = source.split("/")[1] ?? source;
  return {
    name,
    root: `/tmp/atlas-preview/${name}`,
    // No `.claude-plugin/plugin.json` — the common case, and the one that makes
    // the modal fall back to the contained skills' own descriptions.
    manifest: null,
    components: hit
      ? [
          component(
            "skill",
            hit.skillId,
            `skills/${hit.skillId}/SKILL.md`,
            `${hit.name} — published by ${source}.`,
          ),
        ]
      : [],
  };
}

// ── The ACP registry (Settings → Agents) ────────────────────────────────────

/** A monochrome `currentColor` glyph, the shape registry manifests publish —
 *  `ExternalAgentIcon` masks these with the surrounding text color, which is a
 *  different render path from a self-colored icon, so both are represented. */
function monoIcon(path: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">${path}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** A self-colored icon — drawn as an <img>, never masked. */
function colorIcon(fill: string, path: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="${fill}">${path}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const DIAMOND = '<path d="M8 1l7 7-7 7-7-7z"/>';
const RING = '<path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a4 4 0 110 8 4 4 0 010-8z"/>';
const BARS = '<path d="M2 3h12v2H2zm0 4h8v2H2zm0 4h12v2H2z"/>';

let registry: AcpRegistryEntry[] = [
  {
    id: "claude-acp",
    name: "Claude Code",
    version: "1.8.3",
    description: "Anthropic's coding agent, speaking ACP over stdio.",
    repository: "https://github.com/anthropics/claude-code-acp",
    website: "https://claude.com/product/claude-code",
    iconDataUrl: monoIcon(DIAMOND),
    installed: true,
    platformSupported: true,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
  {
    // Detected, never installed: the catalog entry below carries
    // `source: "detected"`, which is what turns this card into "Use this copy".
    id: "codex-acp",
    name: "Codex",
    version: "0.44.0",
    description: "OpenAI's Codex CLI with an ACP bridge.",
    repository: "https://github.com/openai/codex",
    website: "https://openai.com/codex",
    iconDataUrl: monoIcon(RING),
    installed: false,
    platformSupported: true,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
  {
    id: "opencode",
    name: "OpenCode",
    version: "0.6.14",
    description: "Open-source terminal agent with a provider-agnostic model layer.",
    repository: "https://github.com/sst/opencode",
    website: "https://opencode.ai",
    iconDataUrl: monoIcon(BARS),
    installed: false,
    platformSupported: true,
    distributionKind: "npx",
    unverified: false,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
  {
    // No build for this machine: the card stays visible and disabled rather
    // than being filtered out, so the list doesn't silently differ per machine.
    id: "cursor",
    name: "Cursor Agent",
    version: "2.1.0",
    description: "Cursor's headless agent. Ships a Linux build only.",
    repository: "https://github.com/cursor/agent",
    website: "https://cursor.com",
    iconDataUrl: colorIcon("#7aa2f7", DIAMOND),
    installed: false,
    platformSupported: false,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: "no darwin-aarch64 target published",
    installedVersion: null,
    updateAvailable: false,
  },
  {
    // Binary distribution with no published sha256 — the "unverified" chip.
    id: "pi-acp",
    name: "Pi",
    version: "0.3.0-rc.4",
    description: "A small research agent; pre-release builds publish no checksum.",
    repository: "https://github.com/pi-labs/pi-acp",
    website: null,
    iconDataUrl: null,
    installed: false,
    platformSupported: true,
    distributionKind: "binary",
    unverified: true,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
  {
    id: "gemini-cli-acp",
    name: "Gemini CLI",
    version: "0.12.1",
    description: "Google's Gemini CLI, fetched by npm on first spawn.",
    repository: "https://github.com/google-gemini/gemini-cli",
    website: "https://ai.google.dev",
    iconDataUrl: monoIcon(RING),
    installed: false,
    platformSupported: true,
    distributionKind: "npx",
    unverified: false,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
  {
    id: "kilo-code",
    name: "Kilo Code",
    version: "4.2.0",
    description: "Kilo's agent, installed and launched through npx.",
    repository: "https://github.com/kilo-org/kilo-code",
    website: "https://kilocode.ai",
    iconDataUrl: monoIcon(BARS),
    installed: true,
    platformSupported: true,
    distributionKind: "npx",
    unverified: false,
    unsupportedReason: null,
    // Installed npx copy older than the registry's — the Update button.
    installedVersion: "4.1.0",
    updateAvailable: true,
  },
  {
    id: "goose",
    name: "Goose",
    version: "1.6.0",
    description: "Block's extensible on-machine agent.",
    repository: "https://github.com/block/goose",
    website: "https://block.github.io/goose",
    iconDataUrl: null,
    installed: false,
    platformSupported: true,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
  {
    // No description published: the card has to survive a null there.
    id: "amp-acp",
    name: "Amp",
    version: "0.9.7",
    description: null,
    repository: "https://github.com/sourcegraph/amp",
    website: null,
    iconDataUrl: null,
    installed: false,
    platformSupported: true,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
  {
    id: "aider-acp",
    name: "Aider",
    version: "0.87.2",
    description: "Pair-programming agent that edits your git working tree directly.",
    repository: "https://github.com/Aider-AI/aider",
    website: "https://aider.chat",
    iconDataUrl: monoIcon(DIAMOND),
    installed: false,
    platformSupported: true,
    distributionKind: "npx",
    unverified: false,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
  {
    id: "continue-acp",
    name: "Continue",
    version: "1.4.9",
    description: "Continue's CLI agent, configured from the same YAML as its IDE extension.",
    repository: "https://github.com/continuedev/continue",
    website: "https://continue.dev",
    iconDataUrl: monoIcon(BARS),
    installed: false,
    platformSupported: true,
    distributionKind: "npx",
    unverified: false,
    unsupportedReason: null,
    installedVersion: null,
    updateAvailable: false,
  },
];

// ── The agent catalog ───────────────────────────────────────────────────────
// One answer to "which agents exist and how would each launch right now". The
// native agent is `installed: false` here exactly as Rust reports it: there is
// no installed-map entry to point at, because it is in-process.

let catalog: AgentCatalogEntry[] = [
  {
    id: "atlas-agent",
    agentType: "atlas-agent",
    name: "Atlas Agent",
    description: "Atlas's own agent, running in-process — no subprocess, no install.",
    version: "0.0.0-mock",
    kind: "native",
    source: "in-process",
    resolvedPath: null,
    installed: false,
    supportsModes: true,
    supportsModels: true,
    transcript: "native",
    enabled: true,
    displayName: null,
    launch: null,
    hiddenModels: [],
    modelOrder: [],
    customModels: [],
    login: null,
    authKinds: ["env_var"],
    supportsLogout: false,
    supportsFork: false,
    supportsRewind: true,
    iconDataUrl: null,
    helpUrl: null,
    repository: null,
    website: null,
    platformSupported: true,
    distributionKind: "",
    unverified: false,
    unsupportedReason: null,
  },
  {
    // Installed and already connected once, so its advertised capabilities are
    // known — `authKinds` and `supportsLogout` are empty/false until then.
    id: "claude-acp",
    agentType: "claude-code",
    name: "Claude Code",
    description: "Anthropic's coding agent, speaking ACP over stdio.",
    version: "1.8.3",
    kind: "external",
    source: "installed",
    resolvedPath: `${HOME}/.atlas/agents/claude-acp/bin/claude-code-acp`,
    installed: true,
    supportsModes: true,
    supportsModels: true,
    transcript: "none",
    enabled: true,
    displayName: null,
    launch: {
      command: null,
      args: ["--verbose"],
      variables: [
        { name: "CLAUDE_CODE_MAX_OUTPUT_TOKENS", value: "32000", sensitive: false },
        { name: "ANTHROPIC_API_KEY", value: null, sensitive: true },
      ],
    },
    hiddenModels: [],
    modelOrder: [],
    customModels: [],
    login: { program: "claude", args: ["setup-token"] },
    authKinds: ["agent", "terminal"],
    supportsLogout: true,
    supportsFork: true,
    supportsRewind: false,
    iconDataUrl: monoIcon(DIAMOND),
    helpUrl: "https://github.com/anthropics/claude-code-acp",
    repository: "https://github.com/anthropics/claude-code-acp",
    website: "https://claude.com/product/claude-code",
    platformSupported: true,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: null,
  },
  {
    // npx: installed, but nothing is resolved on disk until npm fetches it on
    // the first spawn — hence `resolvedPath: null` with `installed: true`.
    id: "kilo-code",
    agentType: "kilo-code",
    name: "Kilo Code",
    description: "Kilo's agent, installed and launched through npx.",
    version: "4.2.0",
    kind: "external",
    source: "npx",
    resolvedPath: null,
    installed: true,
    supportsModes: false,
    supportsModels: true,
    transcript: "none",
    enabled: true,
    displayName: null,
    launch: { command: null, args: [], variables: [] },
    hiddenModels: [],
    modelOrder: [],
    customModels: [],
    login: null,
    authKinds: [],
    supportsLogout: false,
    supportsFork: false,
    supportsRewind: false,
    iconDataUrl: monoIcon(BARS),
    helpUrl: "https://github.com/kilo-org/kilo-code",
    repository: "https://github.com/kilo-org/kilo-code",
    website: "https://kilocode.ai",
    platformSupported: true,
    distributionKind: "npx",
    unverified: false,
    unsupportedReason: null,
  },
  {
    // On PATH but never installed: an offer, not a spawn candidate. Accepting
    // it writes a custom entry pointing at this very binary.
    id: "codex-acp",
    agentType: "codex-acp",
    name: "Codex",
    description: "OpenAI's Codex CLI with an ACP bridge.",
    version: "0.44.0",
    kind: "external",
    source: "detected",
    resolvedPath: "/opt/homebrew/bin/codex-acp",
    installed: false,
    supportsModes: false,
    supportsModels: false,
    transcript: "none",
    enabled: true,
    displayName: null,
    launch: { command: "/opt/homebrew/bin/codex-acp", args: [], variables: [] },
    hiddenModels: [],
    modelOrder: [],
    customModels: [],
    login: null,
    authKinds: [],
    supportsLogout: false,
    supportsFork: false,
    supportsRewind: false,
    iconDataUrl: monoIcon(RING),
    helpUrl: "https://github.com/openai/codex",
    repository: "https://github.com/openai/codex",
    website: "https://openai.com/codex",
    platformSupported: true,
    distributionKind: "",
    unverified: false,
    unsupportedReason: null,
  },
  {
    // Installed but not in the registry listing — the marketplace synthesizes a
    // card for it, which is the only way its Remove button exists.
    id: "acme-internal-acp",
    agentType: "acme-internal-acp",
    name: "Acme Internal Agent",
    description: "An in-house agent installed from a private repo; never published.",
    version: "0.7.0",
    kind: "external",
    source: "installed",
    resolvedPath: "/usr/local/bin/acme-agent",
    installed: true,
    supportsModes: false,
    supportsModels: false,
    transcript: "none",
    enabled: true,
    displayName: null,
    launch: {
      command: "/usr/local/bin/acme-agent",
      args: ["--acp"],
      variables: [{ name: "ACME_REGION", value: "eu-west-1", sensitive: false }],
    },
    hiddenModels: [],
    modelOrder: [],
    customModels: [],
    login: null,
    authKinds: ["env_var"],
    supportsLogout: false,
    supportsFork: false,
    supportsRewind: false,
    iconDataUrl: null,
    helpUrl: null,
    repository: null,
    website: null,
    platformSupported: true,
    distributionKind: "",
    unverified: false,
    unsupportedReason: null,
  },
  {
    // Installed map entry whose binary is gone: nothing runnable, so the picker
    // must show it as unavailable rather than offering to spawn it.
    id: "sunset-acp",
    agentType: "sunset-acp",
    name: "Sunset Agent",
    description: null,
    version: null,
    kind: "external",
    source: "unavailable",
    resolvedPath: null,
    installed: true,
    supportsModes: false,
    supportsModels: false,
    transcript: "none",
    enabled: true,
    displayName: null,
    launch: { command: null, args: [], variables: [] },
    hiddenModels: [],
    modelOrder: [],
    customModels: [],
    login: null,
    authKinds: [],
    supportsLogout: false,
    supportsFork: false,
    supportsRewind: false,
    iconDataUrl: null,
    helpUrl: null,
    repository: null,
    website: null,
    platformSupported: false,
    distributionKind: "",
    unverified: false,
    unsupportedReason: "the installed binary no longer exists",
  },
];

/** Where a detection's binary was found, kept across an install so uninstalling
 *  an accepted detection returns the agent to "detected" rather than deleting
 *  it — the user's own copy is still on their PATH. */
const detectedPaths = new Map<string, string>([["codex-acp", "/opt/homebrew/bin/codex-acp"]]);

/** Counts `acp_registry_list` calls: the first one answers mid-fetch, because
 *  at boot the backend really is still fetching and the frontend has to treat
 *  an empty-ish listing as "not yet" rather than "nothing published". */
let listCalls = 0;

const REGISTRY_STALE_ERROR =
  "registry fetch failed: the last attempt timed out after 10s — entries below came off the disk cache";

function catalogEntryFor(agentId: string): AgentCatalogEntry | undefined {
  return catalog.find((entry) => entry.id === agentId);
}

/** Promote a registry entry into a catalog entry — what the installed map gains
 *  when an install lands. */
function catalogFromRegistry(
  entry: AcpRegistryEntry,
  resolvedPath: string | null,
): AgentCatalogEntry {
  return {
    id: entry.id,
    agentType: entry.id,
    name: entry.name,
    description: entry.description,
    version: entry.version || null,
    kind: "external",
    source: entry.distributionKind === "npx" ? "npx" : "installed",
    resolvedPath,
    installed: true,
    supportsModes: false,
    supportsModels: false,
    transcript: "none",
    enabled: true,
    displayName: null,
    launch: { command: null, args: [], variables: [] },
    hiddenModels: [],
    modelOrder: [],
    customModels: [],
    login: null,
    // Empty until the agent has connected once: capabilities only exist after
    // the handshake, and a fresh install has never handshaken.
    authKinds: [],
    supportsLogout: false,
    supportsFork: false,
    supportsRewind: false,
    iconDataUrl: entry.iconDataUrl,
    helpUrl: entry.repository ?? entry.website,
    repository: entry.repository,
    website: entry.website,
    platformSupported: entry.platformSupported,
    distributionKind: entry.distributionKind,
    unverified: entry.unverified,
    unsupportedReason: entry.unsupportedReason,
  };
}

/** `agents_configure`'s write, on a catalog entry. Shared with the Northwind
 *  scenario, which keeps a catalog of its own. */
export function applyAgentConfig(entry: AgentCatalogEntry, p: AgentConfigPatch): AgentCatalogEntry {
  if (p.enabled !== undefined) {
    if (entry.kind === "native" && !p.enabled) throw new Error("Atlas Agent can't be turned off");
    entry.enabled = p.enabled;
  }
  if (p.displayName !== undefined) entry.displayName = p.displayName?.trim() || null;
  if (p.hiddenModels !== undefined) entry.hiddenModels = p.hiddenModels;
  if (p.modelOrder !== undefined) entry.modelOrder = p.modelOrder;
  if (p.customModels !== undefined) {
    if (entry.kind === "native") throw new Error("Atlas Agent takes no custom models");
    entry.customModels = p.customModels;
  }
  if (p.launch !== undefined) {
    if (!entry.launch) throw new Error(`${entry.name} runs in-process; it has no launch settings`);
    if (p.launch.command !== undefined && entry.launch.command === null && p.launch.command) {
      throw new Error(`${entry.name}'s command comes from the registry`);
    }
    const { variables, ...rest } = p.launch;
    entry.launch = { ...entry.launch, ...rest };
    if (variables) {
      // Like the keychain: a sensitive value goes in and never comes back.
      const named = (sensitive: boolean) =>
        variables
          .filter((v) => v.sensitive === sensitive)
          .map((v) => ({ name: v.name, value: sensitive ? null : (v.value ?? ""), sensitive }))
          .sort((a, b) => a.name.localeCompare(b.name));
      entry.launch.variables = [...named(false), ...named(true)];
    }
    if (p.launch.command) entry.resolvedPath = p.launch.command;
  }
  return entry;
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface SkillsResponses {
  skills_list: SkillMeta[];
  skills_read: SkillContent;
  skills_path: string;
  skills_project: Unit;
  skills_unproject: Unit;
  skills_set_enabled: Unit;
  skills_adopt: SkillMeta;
  skills_promote: SkillMeta;
  skills_freeze: Unit;
  skills_delete: Unit;
  skills_reconcile: ReconcileView;
  tools_list: AgentTarget[];
  agents_list_skill_targets: AgentTarget[];
  pack_list: InstalledPack[];
  pack_inspect: Pack;
  pack_projections: PackProjectionView[];
  pack_project: PackProjectReport[];
  pack_unproject: Unit;
  pack_uninstall: Unit;
  pack_check_update: PackUpdateCheck;
  pack_components_list: PackComponentMeta[];
  pack_search: PackSearchHit[];
  pack_remote_preview: Pack;
  pack_install_remote: PackInstallResult;
  pack_install_skill: Unread;
  acp_registry_list: AcpRegistryListing;
  acp_registry_refresh: AcpRegistryListing;
  acp_registry_metadata: AcpRegistryEntry | null;
  acp_registry_install: Unit;
  acp_registry_install_detected: Unit;
  acp_registry_uninstall: Unit;
  acp_registry_update: Unit;
  agents_catalog: AgentCatalog;
  agents_catalog_refresh: AgentCatalog;
  agents_configure: AgentCatalogEntry;
  agents_open_config_file: string;
}

export const skillsHandlers: TypedHandlers<SkillsResponses> = {
  // ── skills ───────────────────────────────────────────────────────────────
  skills_list: ({ scope }): SkillMeta[] => {
    const s = asScope(scope);
    return installedSkills.filter((skill) => skill.scope === s).map(metaOf);
  },
  skills_read: ({ scope, name }): SkillContent => {
    const skill = findSkill(asScope(scope), String(name));
    const { raw, body } = skillMarkdown(
      skill.name,
      skill.description,
      skill.overview,
      skill.snippet,
    );
    return { name: skill.name, description: skill.description, body, raw };
  },
  skills_path: ({ scope, name }): string => skillPath(findSkill(asScope(scope), String(name))),

  skills_project: ({ scope, name, tool, force }): null => {
    const skill = findSkill(asScope(scope), String(name));
    const toolId = String(tool);
    const current = skill.cells[toolId]?.status;
    // The non-destructive guard: an edited copy or a foreign skill is only
    // overwritten when the caller says so.
    if (!force && (current === "drifted" || current === "external" || current === "conflict")) {
      throw new Error(`${skill.name} already exists in ${toolId} and differs — re-run with force`);
    }
    skill.cells[toolId] = { status: "synced", mode: "symlink" };
    return null;
  },
  skills_unproject: ({ scope, name, tool }): null => {
    const skill = findSkill(asScope(scope), String(name));
    delete skill.cells[String(tool)];
    return null;
  },
  // The older per-agent toggle: the same two writes behind one boolean.
  skills_set_enabled: ({ scope, name, agent, enabled }): null => {
    const skill = findSkill(asScope(scope), String(name));
    if (enabled) skill.cells[String(agent)] = { status: "synced", mode: "symlink" };
    else delete skill.cells[String(agent)];
    return null;
  },

  skills_adopt: ({ scope, name }): SkillMeta => {
    const s = asScope(scope);
    const skill = findSkill(s, String(name));
    skill.managed = true;
    for (const tool of TOOLS) {
      if (detectedIn(tool, s)) skill.cells[tool.id] = { status: "synced", mode: "symlink" };
    }
    return metaOf(skill);
  },
  skills_promote: ({ name }): SkillMeta => {
    const skill = findSkill("project", String(name));
    if (installedSkills.some((s) => s.scope === "global" && s.name === skill.name)) {
      throw new Error(`a global skill named '${skill.name}' already exists`);
    }
    skill.scope = "global";
    return metaOf(skill);
  },
  // Every symlink in the scope becomes a real copy, so uninstalling Atlas can't
  // take the projected skills with it.
  skills_freeze: ({ scope }): null => {
    const s = asScope(scope);
    for (const skill of installedSkills) {
      if (skill.scope !== s) continue;
      for (const cell of Object.values(skill.cells)) {
        if (cell.mode === "symlink") cell.mode = "copy";
      }
    }
    return null;
  },
  skills_delete: ({ scope, name }): null => {
    const s = asScope(scope);
    const target = String(name);
    installedSkills = installedSkills.filter(
      (skill) => !(skill.scope === s && skill.name === target),
    );
    return null;
  },

  skills_reconcile: ({ scope }): ReconcileView => {
    const s = asScope(scope);
    return {
      tools: TOOLS,
      skills: installedSkills
        .filter((skill) => skill.scope === s)
        .map((skill): ReconciledSkill => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          managed: skill.managed,
          pack: skill.pack,
          cells: cellsOf(skill),
        })),
    };
  },

  tools_list: ({ scope }): AgentTarget[] => targets(asScope(scope)),
  agents_list_skill_targets: ({ scope }): AgentTarget[] => targets(asScope(scope)),

  // ── packs ────────────────────────────────────────────────────────────────
  pack_list: ({ scope }): InstalledPack[] => {
    const s = asScope(scope);
    return installedPacks
      .filter((p) => p.scope === s)
      .map(({ pack, source, commit, installedAt, updatedAt }) => ({
        pack,
        source,
        commit,
        installedAt,
        updatedAt,
      }));
  },
  pack_inspect: ({ dir }): Pack => {
    const root = String(dir);
    const found = installedPacks.find((p) => p.pack.root === root);
    if (!found) throw new Error(`no pack manifest under ${root}`);
    return found.pack;
  },
  pack_projections: ({ scope, pack }): PackProjectionView[] => {
    const found = findPack(asScope(scope), String(pack));
    return found.tools.flatMap((tool) =>
      found.pack.components
        .map((component) => {
          const { mode, status } = projectionModeFor(tool, component.kind);
          if (status !== "projected") return null;
          return {
            tool,
            kind: component.kind,
            name: component.name,
            mode,
            targetRel: `${SKILLS_DIR[tool][found.scope]}/${component.name}`,
          } satisfies PackProjectionView;
        })
        .filter((row): row is PackProjectionView => row !== null),
    );
  },
  pack_project: ({ scope, pack, tool, kinds }): PackProjectReport[] => {
    const found = findPack(asScope(scope), String(pack));
    const toolId = String(tool);
    const wanted = Array.isArray(kinds) ? (kinds as string[]) : null;
    if (!found.tools.includes(toolId)) found.tools = [...found.tools, toolId];
    return found.pack.components
      .filter((component) => !wanted || wanted.includes(component.kind))
      .map((component) => ({
        kind: component.kind,
        name: component.name,
        ...projectionModeFor(toolId, component.kind),
      }));
  },
  pack_unproject: ({ scope, pack, tool }): null => {
    const found = findPack(asScope(scope), String(pack));
    found.tools = found.tools.filter((id) => id !== String(tool));
    return null;
  },
  pack_uninstall: ({ scope, pack }): null => {
    const s = asScope(scope);
    const name = String(pack);
    installedPacks = installedPacks.filter((p) => !(p.scope === s && p.pack.name === name));
    // A pack's skills are the pack's: uninstalling takes them with it.
    installedSkills = installedSkills.filter(
      (skill) => !(skill.scope === s && skill.pack === name),
    );
    return null;
  },
  pack_check_update: ({ scope, pack }): PackUpdateCheck => {
    const found = findPack(asScope(scope), String(pack));
    return {
      hasUpdate: found.behind,
      remoteCommit: found.behind ? "d71f0a95c3e846b20f1d8ac74e5b39628017fce4" : found.commit,
    };
  },
  pack_components_list: ({ scope }): PackComponentMeta[] => {
    const s = asScope(scope);
    return installedPacks
      .filter((p) => p.scope === s)
      .flatMap((installed) =>
        installed.pack.components
          // Only the invokable kinds reach the `#` rail — a skill is invoked by
          // name, a hook and a script are not invoked at all.
          .filter(
            (component): component is PackComponent & { kind: "command" | "agent" | "rule" } =>
              component.kind === "command" ||
              component.kind === "agent" ||
              component.kind === "rule",
          )
          .map((component) => ({
            pack: installed.pack.name,
            kind: component.kind,
            name: component.name,
            relPath: component.relPath,
            path: `${installed.pack.root}/${component.relPath}`,
            description: component.description ?? "",
            // Per-agent gating in the rail: a component is offerable only where
            // its pack has actually been projected.
            enabledAgents: installed.tools.filter(
              (tool) => projectionModeFor(tool, component.kind).status === "projected",
            ),
          })),
      );
  },

  pack_search: ({ query }): PackSearchHit[] => {
    const q = String(query ?? "")
      .trim()
      .toLowerCase();
    // The real endpoint 400s on an empty query rather than returning the world.
    if (!q) throw new Error("query must not be empty");
    return SEARCH_INDEX.filter(
      (hit) => hit.name.toLowerCase().includes(q) || hit.source.toLowerCase().includes(q),
    );
  },
  pack_remote_preview: ({ source }): Pack => previewOf(String(source)),

  pack_install_remote: ({ scope, source }): PackInstallResult => {
    const s = asScope(scope);
    const src = String(source);
    const pack = previewOf(src);
    const commit = `${Date.now().toString(16)}0a1b2c3d4e5f60718293a4b5c6d7e8f9`.slice(0, 40);
    const existing = installedPacks.find((p) => p.scope === s && p.pack.name === pack.name);
    if (existing) {
      existing.commit = commit;
      existing.updatedAt = Date.now();
      existing.behind = false;
      return { state: "updated", pack: existing.pack, contentHash: commit };
    }
    installedPacks = [
      ...installedPacks,
      {
        scope: s,
        pack,
        source: src,
        commit,
        installedAt: Date.now(),
        updatedAt: Date.now(),
        tools: [],
        behind: false,
      },
    ];
    return { state: "fresh", pack, contentHash: commit };
  },
  /** Discover's Install: one skill out of a repo, as a managed skill — not the
   *  whole repo as a pack. */
  pack_install_skill: ({ scope, source, skillId }): SkillMeta => {
    const s = asScope(scope);
    const id = String(skillId);
    const existing = installedSkills.find((skill) => skill.scope === s && skill.name === id);
    if (existing) return metaOf(existing);
    const src = String(source);
    const description =
      SEARCH_INDEX.find((hit) => hit.skillId === id && hit.source === src)?.name ?? id;
    const added: MockSkill = {
      name: id,
      description: `Installed from ${src}. ${description} — see the source repo for the full brief.`,
      scope: s,
      managed: true,
      pack: null,
      // Installed, projected nowhere: the user picks the tools afterwards.
      cells: {},
      overview: `Installed from ${src}.`,
      snippet: `atlas skills show ${id}`,
    };
    installedSkills = [...installedSkills, added];
    return metaOf(added);
  },

  // ── ACP registry (supersedes the empty `acp_registry_list` in base.ts) ────
  acp_registry_list: (): AcpRegistryListing => {
    listCalls += 1;
    const midFetch = listCalls === 1;
    return {
      entries: registry,
      // Never confirmed against the network yet — these came off the disk cache.
      lastRefreshedAt: midFetch ? null : new Date(NOW).toISOString(),
      lastError: midFetch ? REGISTRY_STALE_ERROR : null,
      isFetching: midFetch,
    };
  },
  acp_registry_refresh: (): AcpRegistryListing => ({
    entries: registry,
    lastRefreshedAt: new Date().toISOString(),
    lastError: null,
    isFetching: false,
  }),
  acp_registry_metadata: ({ agentId }): AcpRegistryEntry | null =>
    registry.find((entry) => entry.id === String(agentId)) ?? null,
  acp_registry_install: ({ agentId }): null => {
    const id = String(agentId);
    const entry = registry.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`'${id}' is not in the registry`);
    if (!entry.platformSupported) {
      throw new Error(`${entry.name} publishes no build for this platform`);
    }
    entry.installed = true;
    const existing = catalogEntryFor(id);
    if (existing) {
      existing.installed = true;
      existing.source = entry.distributionKind === "npx" ? "npx" : "installed";
    } else {
      catalog = [
        ...catalog,
        catalogFromRegistry(
          entry,
          entry.distributionKind === "npx" ? null : `${HOME}/.atlas/agents/${id}/bin/${id}`,
        ),
      ];
    }
    return null;
  },
  acp_registry_update: async ({ agentId }): Promise<null> => {
    const entry = registry.find((candidate) => candidate.id === String(agentId));
    if (!entry?.installed) throw new Error(`'${String(agentId)}' is not installed`);
    // Long enough to see "Updating…" on the card.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    entry.installedVersion = entry.distributionKind === "npx" ? entry.version : null;
    entry.updateAvailable = false;
    return null;
  },
  /** Accepting a detection: Atlas runs the copy the user already has, so the
   *  entry points at the found binary rather than at a download. */
  acp_registry_install_detected: ({ agentId }): null => {
    const id = String(agentId);
    const found = detectedPaths.get(id);
    if (!found) throw new Error(`'${id}' was not detected on PATH`);
    const entry = registry.find((candidate) => candidate.id === id);
    if (entry) entry.installed = true;
    const existing = catalogEntryFor(id);
    if (existing) {
      existing.installed = true;
      existing.source = "installed";
      existing.resolvedPath = found;
      existing.launch = { command: found, args: [], variables: [] };
    }
    return null;
  },
  acp_registry_uninstall: ({ agentId }): null => {
    const id = String(agentId);
    const entry = registry.find((candidate) => candidate.id === id);
    if (entry) entry.installed = false;
    const detected = detectedPaths.get(id);
    if (detected) {
      // Removing an accepted detection leaves the user's own copy on PATH, so
      // the agent goes back to being an offer rather than disappearing.
      const existing = catalogEntryFor(id);
      if (existing) {
        existing.installed = false;
        existing.source = "detected";
        existing.resolvedPath = detected;
      }
    } else {
      catalog = catalog.filter((candidate) => candidate.id !== id);
    }
    return null;
  },

  // ── agent catalog (supersedes the empty `agents_catalog` in base.ts) ──────
  agents_catalog: (): AgentCatalog => ({
    entries: catalog,
    lastRefreshedAt: null,
    lastDiscoveredAt: null,
    lastError: null,
  }),
  agents_catalog_refresh: (): AgentCatalog => ({
    entries: catalog,
    lastRefreshedAt: new Date().toISOString(),
    lastDiscoveredAt: new Date().toISOString(),
    lastError: null,
  }),
  /** What the real command writes to the installed map (or, for the native
   *  agent, Atlas's own config), applied to the catalog entry it answers. */
  agents_configure: ({ agentId, patch }): AgentCatalogEntry => {
    const entry = catalogEntryFor(String(agentId));
    if (!entry) throw new Error(`'${String(agentId)}' is not an agent Atlas knows`);
    return applyAgentConfig(entry, patch as AgentConfigPatch);
  },
  /** The real command creates the file; the mock only expands `~`. */
  agents_open_config_file: ({ path }): string => String(path).replace(/^~(?=\/|$)/, "/Users/dev"),
};
