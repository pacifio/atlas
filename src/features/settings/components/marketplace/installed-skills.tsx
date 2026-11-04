// Settings → Skills → Installed. Every installed skill by its real name, plus
// packs that ship no skills. Manage opens one dialog: what the skill does, the
// agent tools it is delivered to, and update / uninstall.

import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { copyText } from "@/lib/clipboard";
import { openFile } from "@/lib/open-file";
import { skills as skillsApi } from "@/features/skills/lib/skills-api";
import { packs as packsApi } from "@/features/packs/lib/packs-api";
import { SKILLS_CHANGED_EVENT } from "@/features/skills/lib/skills-events";
import {
  deliveredToolNames,
  githubUrlFor,
  installedLists,
  mergeOptimistic,
  packMarkdown,
  skillOrigin,
  skillToolStatus,
} from "@/features/skills/lib/skills-view-model";
import type {
  ProjectionStatus,
  ReconciledSkill,
  ReconcileView,
  Scope,
  ToolInfo,
} from "@/features/skills/lib/types";
import type { InstalledPack } from "@/features/packs/lib/types";

import {
  InstalledSkillsView,
  PackManageDialogView,
  PackUpdateButton,
  SkillManageDialogView,
  type PackUpdateState,
} from "./views/installed-skills-view";

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
  const { packsNoSkills, skills } = useMemo(() => installedLists(view, packList), [view, packList]);
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

  const onPack = (name: string) => {
    const pack = packByName.get(name);
    if (pack) setTarget({ kind: "pack", pack });
  };
  const closeModal = () => {
    setTarget(null);
    setOptimistic({});
  };

  // Re-derive the live skill or pack on every render, so a toggle shows at
  // once; the captured `target` is a snapshot from click time.
  let modal = null;
  if (target?.kind === "pack") {
    const name = target.pack.pack.name;
    const pack = packByName.get(name) ?? target.pack;
    const packSkills = (view?.skills ?? [])
      .filter((s) => s.pack === name)
      .map((s) => ({ name: s.name, description: s.description }));
    const projected = mergeOptimistic(packProjected[name] ?? new Set<string>(), optimistic);
    modal = (
      <PackManageDialogView
        pack={pack}
        skills={packSkills}
        deliverTo={{
          tools,
          detectedFor,
          statusFor: (t) => (projected.has(t.id) ? "synced" : "absent"),
          busyFor: (t) => busy === `pack:${name}:${t.id}`,
          onToggle: (t) => void togglePackTool(name, t.id, !projected.has(t.id)),
        }}
        uninstalling={busy === `delpack:${name}`}
        update={
          <PackUpdate
            scope={scope}
            name={name}
            source={pack.source}
            effectiveProject={effectiveProject}
            projectedTools={projected}
            onDone={() => void refresh()}
          />
        }
        onUninstall={() => void uninstallPack(name)}
        onCopy={() => void copyText(packMarkdown(pack, packSkills))}
        onOpenGithub={() => void openUrl(githubUrlFor(pack.source))}
        onClose={closeModal}
      />
    );
  } else if (target?.kind === "skill") {
    const name = target.skill.name;
    const skill = (view?.skills ?? []).find((s) => s.name === name) ?? target.skill;
    modal = (
      <SkillManageDialogView
        skill={{ name: skill.name, description: skill.description }}
        subtitle={skill.managed ? "Your skill" : "Found in an agent's folder"}
        deliverTo={{
          tools,
          detectedFor,
          statusFor: (t) => skillToolStatus(skill, t.id, scope, optimistic),
          busyFor: (t) => busy === `skill:${skill.name}:${t.id}`,
          onToggle: (t, status) => void toggleSkillTool(name, t.id, status),
        }}
        canPromote={scope === "project"}
        uninstalling={busy === `del:${skill.name}`}
        promoting={busy === `promote:${skill.name}`}
        onOpen={() => void openSkill(name)}
        onPromote={() => void promoteSkill(name)}
        onUninstall={() => void uninstallSkill(name)}
        onClose={closeModal}
      />
    );
  }

  return (
    <InstalledSkillsView
      loaded={view !== null}
      loadError={loadError}
      packsNoSkills={packsNoSkills}
      skills={skills.map((s) => ({
        skill: s,
        origin: skillOrigin(s),
        toolNames: deliveredToolNames(s, tools, scope),
      }))}
      onManagePack={onPack}
      onManageSkill={(s) =>
        s.pack && packByName.has(s.pack) ? onPack(s.pack) : setTarget({ kind: "skill", skill: s })
      }
    >
      {modal}
    </InstalledSkillsView>
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
  const [state, setState] = useState<PackUpdateState>("idle");

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

  return (
    <PackUpdateButton state={state} onCheck={() => void check()} onApply={() => void apply()} />
  );
}
