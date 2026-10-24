// Settings → Skills → Installed. Every installed skill by its real name, plus
// packs that ship no skills. Manage opens one dialog: what the skill does, the
// agent tools it is delivered to, and update / uninstall.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpCircle,
  ChevronRight,
  Copy,
  ExternalLink,
  Package,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { copyText } from "@/lib/clipboard";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { AtlasLoader } from "@/components/atlas-loader";
import { openFile } from "@/lib/open-file";
import { skills as skillsApi } from "@/features/skills/lib/skills-api";
import { packs as packsApi } from "@/features/packs/lib/packs-api";
import { SKILLS_CHANGED_EVENT } from "@/features/skills/lib/skills-events";
import type {
  ProjectionStatus,
  ReconciledSkill,
  ReconcileView,
  Scope,
  ToolInfo,
} from "@/features/skills/lib/types";
import type { ComponentKind, InstalledPack } from "@/features/packs/lib/types";

import { DeliverTo, SkillDescriptions, SkillDialog } from "./skill-modal";
import {
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";

/** Apply the per-tool optimistic overrides (toolId → on) on top of a projected
 *  set, so a pack toggle reflects instantly before the disk reconcile lands. */
function mergeOptimistic(base: Set<string>, optimistic: Record<string, boolean>): Set<string> {
  const next = new Set(base);
  for (const [toolId, on] of Object.entries(optimistic)) {
    if (on) next.add(toolId);
    else next.delete(toolId);
  }
  return next;
}

const KIND_LABEL: Record<ComponentKind, string> = {
  skill: "skills",
  agent: "agents",
  command: "commands",
  hook: "hooks",
  rule: "rules",
  script: "scripts",
};

function kindCounts(components: { kind: ComponentKind }[]): string {
  const m = new Map<ComponentKind, number>();
  for (const c of components) m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
  return [...m.entries()]
    .map(([k, n]) => `${n} ${n === 1 ? KIND_LABEL[k].slice(0, -1) : KIND_LABEL[k]}`)
    .join(" · ");
}

type ModalTarget =
  | { kind: "pack"; pack: InstalledPack }
  | { kind: "skill"; skill: ReconciledSkill }
  | null;

interface InstalledSnapshot {
  view: ReconcileView | null;
  packList: InstalledPack[];
  packProjected: Record<string, Set<string>>;
}
// Cache the installed view (reconcile + packs + projections) per scope so
// re-entering Skills or flipping scope paints instantly, then revalidates
// in the background. Mutations re-fetch and overwrite the entry.
const installedCache = new Map<string, InstalledSnapshot>();
const cacheKeyFor = (scope: Scope, project: string | null) => `${scope}:${project ?? ""}`;

export function InstalledSkills({
  scope,
  projectPath,
}: {
  scope: Scope;
  projectPath: string | null;
}) {
  const effectiveProject = scope === "project" ? projectPath : null;
  const projectMissing = scope === "project" && !projectPath;

  const seed = installedCache.get(cacheKeyFor(scope, effectiveProject));
  const [view, setView] = useState<ReconcileView | null>(seed?.view ?? null);
  const [packList, setPackList] = useState<InstalledPack[]>(seed?.packList ?? []);
  const [packProjected, setPackProjected] = useState<Record<string, Set<string>>>(
    seed?.packProjected ?? {},
  );
  const [target, setTarget] = useState<ModalTarget>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Optimistic per-tool override (toolId → on) for the open modal, so a toggle
  // flips instantly instead of waiting for the disk-reconcile round-trip. Keyed
  // by toolId only (one modal open at a time); cleared once refresh lands.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  // A first load that fails with nothing cached would otherwise read as
  // loading forever once its toast is gone.
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (projectMissing) {
      setView(null);
      setPackList([]);
      setPackProjected({});
      return;
    }
    const key = cacheKeyFor(scope, effectiveProject);
    // Paint the cached snapshot immediately (stale-while-revalidate).
    const cached = installedCache.get(key);
    if (cached) {
      setView(cached.view);
      setPackList(cached.packList);
      setPackProjected(cached.packProjected);
    }
    const [v, pl] = await Promise.all([
      skillsApi.reconcile(scope, effectiveProject),
      packsApi.list(scope, effectiveProject),
    ]);
    setView(v);
    setPackList(pl);
    const entries = await Promise.all(
      pl.map(async (p) => {
        const views = await packsApi.projections(scope, p.pack.name, effectiveProject);
        return [p.pack.name, new Set(views.map((x) => x.tool))] as const;
      }),
    );
    const projected = Object.fromEntries(entries);
    setPackProjected(projected);
    installedCache.set(key, { view: v, packList: pl, packProjected: projected });
  }, [scope, effectiveProject, projectMissing]);

  useEffect(() => {
    setLoadError(null);
    void refresh().catch((e) => {
      setLoadError(String(e));
      toast.error(String(e));
    });
  }, [refresh]);

  // Reflect installs/mutations happening elsewhere (e.g. Discover).
  useEffect(() => {
    const onChanged = () => void refresh().catch(() => {});
    window.addEventListener(SKILLS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const tools = view?.tools ?? [];
  // List every installed skill by its REAL name (authored + pack-provided), so
  // the user sees skill names — not the repo/pack name. A pack-provided skill's
  // row routes to its pack's manage modal (the pack is the install/uninstall
  // unit). Packs that ship NO skills (commands/agents/rules only) still appear
  // as their own rows so they don't vanish.
  const skills = useMemo(
    () => [...(view?.skills ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [view],
  );
  const packsNoSkills = useMemo(
    () => packList.filter((p) => !(view?.skills ?? []).some((s) => s.pack === p.pack.name)),
    [packList, view],
  );
  const packByName = useMemo(() => new Map(packList.map((p) => [p.pack.name, p])), [packList]);

  const detectedFor = (t: ToolInfo) => (scope === "project" ? t.detectedProject : t.detectedGlobal);

  // ── Pack projection ──────────────────────────────────────────────────────
  const togglePackTool = useCallback(
    async (packName: string, toolId: string, on: boolean) => {
      setBusy(`pack:${packName}:${toolId}`);
      setOptimistic((o) => ({ ...o, [toolId]: on }));
      try {
        if (on) await packsApi.project(scope, packName, toolId, null, false, effectiveProject);
        else await packsApi.unproject(scope, packName, toolId, effectiveProject);
        await refresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
        setOptimistic((o) => {
          const next = { ...o };
          delete next[toolId];
          return next;
        });
      }
    },
    [scope, effectiveProject, refresh],
  );

  // ── Skill projection / lifecycle ─────────────────────────────────────────
  const toggleSkillTool = useCallback(
    async (name: string, toolId: string, status: ProjectionStatus) => {
      setBusy(`skill:${name}:${toolId}`);
      setOptimistic((o) => ({ ...o, [toolId]: status !== "synced" }));
      try {
        if (status === "synced") await skillsApi.unproject(scope, name, toolId, effectiveProject);
        else await skillsApi.project(scope, name, toolId, status === "drifted", effectiveProject);
        await refresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
        setOptimistic((o) => {
          const next = { ...o };
          delete next[toolId];
          return next;
        });
      }
    },
    [scope, effectiveProject, refresh],
  );

  const uninstallSkill = useCallback(
    async (name: string) => {
      setBusy(`del:${name}`);
      try {
        await skillsApi.delete(scope, name, effectiveProject);
        await refresh();
        setTarget(null);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [scope, effectiveProject, refresh],
  );

  const uninstallPack = useCallback(
    async (name: string) => {
      setBusy(`delpack:${name}`);
      try {
        await packsApi.uninstall(scope, name, effectiveProject);
        await refresh();
        setTarget(null);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [scope, effectiveProject, refresh],
  );

  const promoteSkill = useCallback(
    async (name: string) => {
      if (!effectiveProject) return;
      setBusy(`promote:${name}`);
      try {
        await skillsApi.promote(name, effectiveProject);
        await refresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [effectiveProject, refresh],
  );

  const openSkill = useCallback(
    async (name: string) => {
      try {
        void openFile(await skillsApi.path(scope, name, effectiveProject));
      } catch (e) {
        toast.error(String(e));
      }
    },
    [scope, effectiveProject],
  );

  const empty = skills.length === 0 && packList.length === 0;
  const toolNames = (s: ReconciledSkill) =>
    s.cells
      .filter((c) => c.scope === scope && (c.status === "synced" || c.status === "pack"))
      .map((c) => tools.find((t) => t.id === c.tool)?.displayName ?? c.tool);
  const onPack = (name: string) => {
    const pack = packByName.get(name);
    if (pack) setTarget({ kind: "pack", pack });
  };

  return (
    <SettingsSection
      title="Installed"
      description="Skills Atlas keeps, and the agent tools each one is delivered to."
    >
      <SettingsGroup>
        {view === null ? (
          <SettingsNote>
            {loadError ? `Couldn't read the installed skills: ${loadError}` : "Loading skills…"}
          </SettingsNote>
        ) : empty ? (
          <SettingsNote>Nothing installed here yet. Find skills below.</SettingsNote>
        ) : (
          <>
            {/* Packs that ship no skills (commands, agents or rules only). */}
            {packsNoSkills.map((p) => (
              <SettingsRow
                key={`pack:${p.pack.name}`}
                title={
                  <span className="flex items-center gap-1.5">
                    <Icon icon={Package} size="xs" className="text-muted-foreground" />
                    {p.pack.name}
                  </span>
                }
                description={kindCounts(p.pack.components) || undefined}
                status={<span className="font-mono">{p.source}</span>}
                control={<ManageButton name={p.pack.name} onClick={() => onPack(p.pack.name)} />}
              />
            ))}

            {/* Every installed skill, by its real name. A pack's skill is
                managed through its pack, the unit it installs as. */}
            {skills.map((s) => {
              const on = toolNames(s);
              const origin = s.pack
                ? `From ${s.pack}`
                : s.managed
                  ? "Your skill"
                  : "Found in an agent's folder";
              return (
                <SettingsRow
                  key={`skill:${s.pack ?? ""}:${s.name}`}
                  title={s.name}
                  description={
                    s.description ? (
                      <span className="line-clamp-2">{s.description}</span>
                    ) : undefined
                  }
                  status={`${origin} · ${on.length ? `In ${on.join(", ")}` : "Not delivered to any tool"}`}
                  control={
                    <ManageButton
                      name={s.name}
                      onClick={() =>
                        s.pack && packByName.has(s.pack)
                          ? onPack(s.pack)
                          : setTarget({ kind: "skill", skill: s })
                      }
                    />
                  }
                />
              );
            })}
          </>
        )}
      </SettingsGroup>

      {/* Re-derive the live skill or pack on every render, so a toggle shows
          at once; the captured `target` is a snapshot from click time. */}
      {target?.kind === "pack" && (
        <PackManageModal
          pack={packByName.get(target.pack.pack.name) ?? target.pack}
          packSkills={(view?.skills ?? []).filter((s) => s.pack === target.pack.pack.name)}
          tools={tools}
          projected={mergeOptimistic(
            packProjected[target.pack.pack.name] ?? new Set<string>(),
            optimistic,
          )}
          detectedFor={detectedFor}
          busy={busy}
          scope={scope}
          effectiveProject={effectiveProject}
          onToggle={(toolId, on) => void togglePackTool(target.pack.pack.name, toolId, on)}
          onUpdated={() => void refresh()}
          onUninstall={() => void uninstallPack(target.pack.pack.name)}
          onClose={() => {
            setTarget(null);
            setOptimistic({});
          }}
        />
      )}
      {target?.kind === "skill" && (
        <SkillManageModal
          skill={(view?.skills ?? []).find((s) => s.name === target.skill.name) ?? target.skill}
          tools={tools}
          scope={scope}
          detectedFor={detectedFor}
          busy={busy}
          optimistic={optimistic}
          onToggle={(toolId, status) => void toggleSkillTool(target.skill.name, toolId, status)}
          onOpen={() => void openSkill(target.skill.name)}
          onPromote={() => void promoteSkill(target.skill.name)}
          onUninstall={() => void uninstallSkill(target.skill.name)}
          onClose={() => {
            setTarget(null);
            setOptimistic({});
          }}
        />
      )}
    </SettingsSection>
  );
}

function ManageButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" aria-label={`Manage ${name}`} onClick={onClick}>
      Manage
      <Icon icon={ChevronRight} size="xs" />
    </Button>
  );
}

function PackManageModal({
  pack,
  packSkills,
  tools,
  projected,
  detectedFor,
  busy,
  scope,
  effectiveProject,
  onToggle,
  onUpdated,
  onUninstall,
  onClose,
}: {
  pack: InstalledPack;
  packSkills: ReconciledSkill[];
  tools: ToolInfo[];
  projected: Set<string>;
  detectedFor: (t: ToolInfo) => boolean;
  busy: string | null;
  scope: Scope;
  effectiveProject: string | null;
  onToggle: (toolId: string, on: boolean) => void;
  onUpdated: () => void;
  onUninstall: () => void;
  onClose: () => void;
}) {
  const githubUrl = `https://github.com/${pack.source}`;
  const copyMarkdown = () => {
    const lines = [`# ${pack.pack.name}`, ""];
    for (const s of packSkills) {
      lines.push(`## ${s.name}`);
      if (s.description) lines.push("", s.description);
      lines.push("");
    }
    lines.push(`Source: ${githubUrl}`);
    void copyText(lines.join("\n"));
  };

  return (
    <SkillDialog
      open
      onClose={onClose}
      title={pack.pack.name}
      subtitle={[pack.source, kindCounts(pack.pack.components)].filter(Boolean).join(" · ")}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy === `delpack:${pack.pack.name}`}
            onClick={onUninstall}
          >
            <Icon icon={Trash2} size="xs" />
            Uninstall pack
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={copyMarkdown}>
            <Icon icon={Copy} size="xs" />
            Copy as Markdown
          </Button>
          <Button variant="ghost" onClick={() => void openUrl(githubUrl)}>
            <GithubIcon size={12} />
            GitHub
          </Button>
          <PackUpdate
            scope={scope}
            name={pack.pack.name}
            source={pack.source}
            effectiveProject={effectiveProject}
            projectedTools={projected}
            onDone={onUpdated}
          />
        </>
      }
    >
      <SkillDescriptions
        skills={packSkills.map((s) => ({ name: s.name, description: s.description }))}
        fallback="This pack ships no skills, only commands, agents or rules."
      />
      <DeliverTo
        tools={tools}
        detectedFor={detectedFor}
        statusFor={(t) => (projected.has(t.id) ? "synced" : "absent")}
        busyFor={(t) => busy === `pack:${pack.pack.name}:${t.id}`}
        onToggle={(t) => onToggle(t.id, !projected.has(t.id))}
      />
    </SkillDialog>
  );
}

function SkillManageModal({
  skill,
  tools,
  scope,
  detectedFor,
  busy,
  optimistic,
  onToggle,
  onOpen,
  onPromote,
  onUninstall,
  onClose,
}: {
  skill: ReconciledSkill;
  tools: ToolInfo[];
  scope: Scope;
  detectedFor: (t: ToolInfo) => boolean;
  busy: string | null;
  optimistic: Record<string, boolean>;
  onToggle: (toolId: string, status: ProjectionStatus) => void;
  onOpen: () => void;
  onPromote: () => void;
  onUninstall: () => void;
  onClose: () => void;
}) {
  const statusFor = (t: ToolInfo): ProjectionStatus => {
    const ov = optimistic[t.id];
    if (ov !== undefined) return ov ? "synced" : "absent";
    return skill.cells.find((c) => c.tool === t.id && c.scope === scope)?.status ?? "absent";
  };

  return (
    <SkillDialog
      open
      onClose={onClose}
      title={skill.name}
      subtitle={skill.managed ? "Your skill" : "Found in an agent's folder"}
      footer={
        <>
          <Button variant="ghost" disabled={busy === `del:${skill.name}`} onClick={onUninstall}>
            <Icon icon={Trash2} size="xs" />
            Uninstall
          </Button>
          <span className="flex-1" />
          {scope === "project" && (
            <Button variant="ghost" disabled={busy === `promote:${skill.name}`} onClick={onPromote}>
              <Icon icon={ArrowUpCircle} size="xs" />
              Use in all projects
            </Button>
          )}
          <Button variant="outline" onClick={onOpen}>
            <Icon icon={ExternalLink} size="xs" />
            Open in editor
          </Button>
        </>
      }
    >
      <SkillDescriptions skills={[{ name: skill.name, description: skill.description }]} />
      <DeliverTo
        tools={tools}
        detectedFor={detectedFor}
        statusFor={statusFor}
        busyFor={(t) => busy === `skill:${skill.name}:${t.id}`}
        onToggle={(t, status) => onToggle(t.id, status)}
      />
    </SkillDialog>
  );
}

/** Check for a newer commit of the pack (a cheap ls-remote), then re-install
 *  it and re-deliver it to the tools it was in. */
function PackUpdate({
  scope,
  name,
  source,
  effectiveProject,
  projectedTools,
  onDone,
}: {
  scope: Scope;
  name: string;
  source: string;
  effectiveProject: string | null;
  projectedTools: Set<string>;
  onDone: () => void;
}) {
  const [state, setState] = useState<"idle" | "checking" | "available" | "uptodate" | "updating">(
    "idle",
  );

  const check = async () => {
    setState("checking");
    try {
      const res = await packsApi.checkUpdate(scope, name, effectiveProject);
      setState(res.hasUpdate ? "available" : "uptodate");
      if (!res.hasUpdate) window.setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("idle");
    }
  };
  const apply = async () => {
    setState("updating");
    try {
      const res = await packsApi.install(scope, source, false, effectiveProject);
      if (res.state === "updated") {
        for (const toolId of projectedTools)
          await packsApi.project(scope, name, toolId, null, true, effectiveProject);
      }
      onDone();
      setState("uptodate");
      window.setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("available");
    }
  };

  if (state === "available") {
    return (
      <Button onClick={() => void apply()}>
        <Icon icon={ArrowUpCircle} size="xs" />
        Update
      </Button>
    );
  }
  const working = state === "checking" || state === "updating";
  return (
    <Button
      variant="outline"
      disabled={working || state === "uptodate"}
      onClick={() => void check()}
    >
      {working ? <AtlasLoader size={11} /> : <Icon icon={RefreshCw} size="xs" />}
      {state === "checking"
        ? "Checking…"
        : state === "updating"
          ? "Updating…"
          : state === "uptodate"
            ? "Up to date"
            : "Check for update"}
    </Button>
  );
}
