import { describe, expect, it } from "vitest";

import type { InstalledPack, Pack, PackSearchHit } from "@/features/packs/lib/types";
import {
  deliveredToolNames,
  detailFromPreview,
  hitMarkdown,
  installedLists,
  kindCounts,
  mergeOptimistic,
  mergePopular,
  packMarkdown,
  skillOrigin,
  skillToolStatus,
} from "./skills-view-model";
import type { ReconciledSkill, ReconcileView, ToolInfo } from "./types";

const hit = (id: string, installs: number): PackSearchHit => ({
  id,
  skillId: id,
  name: id,
  installs,
  source: `acme/${id}`,
});

const pack = (components: Pack["components"], description?: string): Pack => ({
  name: "review-kit",
  root: "/tmp/review-kit",
  manifest: description === undefined ? null : { description },
  components,
});

const comp = (kind: Pack["components"][number]["kind"], name: string, description?: string) => ({
  kind,
  relPath: `${kind}s/${name}`,
  name,
  description,
});

const installedPack = (name: string, components: Pack["components"] = []): InstalledPack => ({
  pack: { name, root: `/p/${name}`, components },
  source: `acme/${name}`,
  commit: "abc",
  installedAt: 0,
  updatedAt: 0,
});

const skill = (name: string, over: Partial<ReconciledSkill> = {}): ReconciledSkill => ({
  name,
  description: `${name} does things`,
  scope: "global",
  managed: true,
  cells: [],
  ...over,
});

const tool = (id: string, displayName: string): ToolInfo => ({
  id,
  displayName,
  detectedGlobal: true,
  detectedProject: true,
  supportsSymlink: true,
  delivery: "native-dir",
});

describe("kindCounts", () => {
  it("counts each kind in first-seen order, singular for one", () => {
    expect(
      kindCounts([{ kind: "command" }, { kind: "hook" }, { kind: "command" }, { kind: "rule" }]),
    ).toBe("2 commands · 1 hook · 1 rule");
  });

  it("is empty for no components", () => {
    expect(kindCounts([])).toBe("");
  });
});

describe("mergeOptimistic", () => {
  it("adds the on overrides and drops the off ones without touching the base", () => {
    const base = new Set(["claude", "codex"]);
    const merged = mergeOptimistic(base, { codex: false, atlas: true });
    expect([...merged].sort()).toEqual(["atlas", "claude"]);
    expect([...base].sort()).toEqual(["claude", "codex"]);
  });
});

describe("mergePopular", () => {
  it("keeps the higher install count for a duplicate id, most installed first", () => {
    const merged = mergePopular([
      [hit("a", 10), hit("b", 50)],
      [hit("a", 70), hit("c", 5)],
    ]);
    expect(merged.map((h) => [h.id, h.installs])).toEqual([
      ["a", 70],
      ["b", 50],
      ["c", 5],
    ]);
  });

  it("is empty for no batches", () => {
    expect(mergePopular([])).toEqual([]);
    expect(mergePopular([[], []])).toEqual([]);
  });
});

describe("detailFromPreview", () => {
  it("is empty for no preview", () => {
    expect(detailFromPreview(null)).toEqual({
      manifestDescription: null,
      skills: [],
      otherCounts: [],
    });
  });

  it("lists the skills and counts the other kinds", () => {
    const d = detailFromPreview(
      pack(
        [
          comp("skill", "code-review", "Review a diff."),
          comp("command", "ship"),
          comp("rule", "style"),
          comp("command", "land"),
        ],
        "Review tools.",
      ),
    );
    expect(d.manifestDescription).toBe("Review tools.");
    expect(d.skills).toEqual([{ name: "code-review", description: "Review a diff." }]);
    expect(d.otherCounts).toEqual([
      ["command", 2],
      ["rule", 1],
    ]);
  });

  it("treats an empty manifest description as none", () => {
    expect(detailFromPreview(pack([], "")).manifestDescription).toBeNull();
    expect(detailFromPreview(pack([comp("skill", "x")])).manifestDescription).toBeNull();
  });
});

describe("hitMarkdown", () => {
  it("is the name and the source without a preview", () => {
    expect(hitMarkdown(hit("code-review", 1), null)).toBe(
      "# code-review\n\nSource: https://github.com/acme/code-review",
    );
  });

  it("adds the description and each skill from the preview", () => {
    const preview = pack(
      [comp("skill", "code-review", "Review a diff."), comp("skill", "pr"), comp("command", "x")],
      "Review tools.",
    );
    expect(hitMarkdown(hit("code-review", 1), preview)).toBe(
      [
        "# code-review",
        "",
        "Review tools.",
        "",
        "## code-review",
        "",
        "Review a diff.",
        "",
        "## pr",
        "",
        "Source: https://github.com/acme/code-review",
      ].join("\n"),
    );
  });
});

describe("packMarkdown", () => {
  it("is the pack name, its skills and the source", () => {
    expect(
      packMarkdown(installedPack("frontend-toolkit"), [
        { name: "react-performance", description: "Find re-renders." },
        { name: "design-system-audit", description: null },
      ]),
    ).toBe(
      [
        "# frontend-toolkit",
        "",
        "## react-performance",
        "",
        "Find re-renders.",
        "",
        "## design-system-audit",
        "",
        "Source: https://github.com/acme/frontend-toolkit",
      ].join("\n"),
    );
  });
});

describe("installedLists", () => {
  it("keeps packs with no skills and sorts the skills by name", () => {
    const view: ReconcileView = {
      tools: [],
      skills: [skill("zeta"), skill("alpha", { pack: "kit" }), skill("mid")],
    };
    const { packsNoSkills, skills } = installedLists(view, [
      installedPack("kit"),
      installedPack("rules-only"),
    ]);
    expect(packsNoSkills.map((p) => p.pack.name)).toEqual(["rules-only"]);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("lists every pack before the first reconcile", () => {
    const { packsNoSkills, skills } = installedLists(null, [installedPack("kit")]);
    expect(packsNoSkills).toHaveLength(1);
    expect(skills).toEqual([]);
  });
});

describe("skillOrigin", () => {
  it("names the pack, then Atlas's own, then an agent's folder", () => {
    expect(skillOrigin(skill("a", { pack: "kit" }))).toBe("From kit");
    expect(skillOrigin(skill("a"))).toBe("Your skill");
    expect(skillOrigin(skill("a", { managed: false }))).toBe("Found in an agent's folder");
  });
});

describe("deliveredToolNames", () => {
  it("names the synced and pack cells in this scope", () => {
    const s = skill("a", {
      cells: [
        { tool: "claude", scope: "global", status: "synced", mode: "symlink" },
        { tool: "codex", scope: "global", status: "drifted", mode: "copy" },
        { tool: "atlas", scope: "global", status: "pack", mode: "symlink" },
        { tool: "claude", scope: "project", status: "synced", mode: "symlink" },
        { tool: "unknown", scope: "global", status: "synced", mode: "symlink" },
      ],
    });
    expect(
      deliveredToolNames(s, [tool("claude", "Claude Code"), tool("atlas", "Atlas")], "global"),
    ).toEqual(["Claude Code", "Atlas", "unknown"]);
    expect(deliveredToolNames(s, [], "project")).toEqual(["claude"]);
  });
});

describe("skillToolStatus", () => {
  const s = skill("a", {
    cells: [
      { tool: "claude", scope: "global", status: "synced", mode: "symlink" },
      { tool: "codex", scope: "global", status: "drifted", mode: "copy" },
      { tool: "atlas", scope: "global", status: "conflict", mode: null },
    ],
  });

  it("reads the cell for this tool and scope, absent when there is none", () => {
    expect(skillToolStatus(s, "claude", "global", {})).toBe("synced");
    expect(skillToolStatus(s, "atlas", "global", {})).toBe("conflict");
    expect(skillToolStatus(s, "claude", "project", {})).toBe("absent");
    expect(skillToolStatus(s, "cursor", "global", {})).toBe("absent");
  });

  it("lets an optimistic override beat the disk, drifted included", () => {
    expect(skillToolStatus(s, "codex", "global", { codex: true })).toBe("synced");
    expect(skillToolStatus(s, "claude", "global", { claude: false })).toBe("absent");
  });
});
