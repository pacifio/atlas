// Settings → Skills → My Skills. The installed set as a dense monochrome data
// table (same essence as Settings → API Keys). Rows don't expand inline — a
// click opens the shared two-panel modal (description left, actions right):
// a pack lists its skills + manages per-tool projection / update; an authored
// skill shows its description + projection / promote / uninstall.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpCircle,
  ChevronRight,
  Copy,
  ExternalLink,
  Github,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { cn } from "@/lib/utils";
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

import { SkillModalShell, SkillDescriptions, ModalAction } from "./skill-modal";

const COL = {
  name: "flex-1 min-w-[200px]",
  origin: "w-[180px] shrink-0",
  tools: "w-[150px] shrink-0",
  chevron: "w-[28px] shrink-0",
} as const;
const TABLE_MIN_W = 200 + 180 + 150 + 28;

/** Apply the per-tool optimistic overrides (toolId → on) on top of a projected
 *  set, so a pack toggle reflects instantly before the disk reconcile lands. */
function mergeOptimistic(
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
  return [...m.entries()].map(([k, n]) => `${n} ${KIND_LABEL[k]}`).join(" · ");
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
// re-entering My Skills or flipping scope paints instantly, then revalidates
// in the background. Mutations re-fetch and overwrite the entry.
const installedCache = new Map<string, InstalledSnapshot>();
const cacheKeyFor = (scope: Scope, project: string | null) =>
  `${scope}:${project ?? ""}`;

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
  const [packList, setPackList] = useState<InstalledPack[]>(
    seed?.packList ?? [],
  );
  const [packProjected, setPackProjected] = useState<
    Record<string, Set<string>>
  >(seed?.packProjected ?? {});
  const [target, setTarget] = useState<ModalTarget>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Optimistic per-tool override (toolId → on) for the open modal, so a toggle
  // flips instantly instead of waiting for the disk-reconcile round-trip. Keyed
  // by toolId only (one modal open at a time); cleared once refresh lands.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

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
        const views = await packsApi.projections(
          scope,
          p.pack.name,
          effectiveProject,
        );
        return [p.pack.name, new Set(views.map((x) => x.tool))] as const;
      }),
    );
    const projected = Object.fromEntries(entries);
    setPackProjected(projected);
    installedCache.set(key, {
      view: v,
      packList: pl,
      packProjected: projected,
    });
  }, [scope, effectiveProject, projectMissing]);

  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
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
    () =>
      [...(view?.skills ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [view],
  );
  const packsNoSkills = useMemo(
    () =>
      packList.filter(
        (p) => !(view?.skills ?? []).some((s) => s.pack === p.pack.name),
      ),
    [packList, view],
  );
  const packByName = useMemo(
    () => new Map(packList.map((p) => [p.pack.name, p])),
    [packList],
  );

  const detectedFor = (t: ToolInfo) =>
    scope === "project" ? t.detectedProject : t.detectedGlobal;

  // ── Pack projection ──────────────────────────────────────────────────────
  const togglePackTool = useCallback(
    async (packName: string, toolId: string, on: boolean) => {
      setBusy(`pack:${packName}:${toolId}`);
      setOptimistic((o) => ({ ...o, [toolId]: on }));
      setError(null);
      try {
        if (on)
          await packsApi.project(
            scope,
            packName,
            toolId,
            null,
            false,
            effectiveProject,
          );
        else
          await packsApi.unproject(scope, packName, toolId, effectiveProject);
        await refresh();
      } catch (e) {
        setError(String(e));
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
      setError(null);
      try {
        if (status === "synced")
          await skillsApi.unproject(scope, name, toolId, effectiveProject);
        else
          await skillsApi.project(
            scope,
            name,
            toolId,
            status === "drifted",
            effectiveProject,
          );
        await refresh();
      } catch (e) {
        setError(String(e));
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
      setError(null);
      try {
        await skillsApi.delete(scope, name, effectiveProject);
        await refresh();
        setTarget(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [scope, effectiveProject, refresh],
  );

  const uninstallPack = useCallback(
    async (name: string) => {
      setBusy(`delpack:${name}`);
      setError(null);
      try {
        await packsApi.uninstall(scope, name, effectiveProject);
        await refresh();
        setTarget(null);
      } catch (e) {
        setError(String(e));
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
        setError(String(e));
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
        setError(String(e));
      }
    },
    [scope, effectiveProject],
  );

  if (projectMissing) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-[11px] text-text-tertiary">
        Open a project to manage workspace skills.
      </div>
    );
  }

  const empty = skills.length === 0 && packList.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="mx-3 mt-2 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-[11px] text-error">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto hide-scrollbar">
        <div style={{ minWidth: TABLE_MIN_W }}>
          <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-border-default bg-bg-base px-3 text-[10px] uppercase tracking-wider text-text-tertiary">
            <span className={COL.name}>Name</span>
            <span className={COL.origin}>Origin</span>
            <span className={COL.tools}>Tools</span>
            <span className={COL.chevron} />
          </div>

          {empty ? (
            <div className="grid h-[180px] place-items-center text-[11px] text-text-tertiary">
              Nothing installed in this scope. Browse Discover to add skills.
            </div>
          ) : (
            <>
              {/* Packs that ship no skills (commands/agents/rules only). */}
              {packsNoSkills.map((p) => {
                const proj = packProjected[p.pack.name] ?? new Set<string>();
                return (
                  <button
                    key={`pack:${p.pack.name}`}
                    onClick={() => setTarget({ kind: "pack", pack: p })}
                    className="flex w-full items-center h-[40px] border-b border-border-subtle px-3 text-left transition-colors hover:bg-bg-hover"
                  >
                    <span
                      className={cn(
                        COL.name,
                        "flex items-center gap-2 min-w-0",
                      )}
                    >
                      <Package
                        size={13}
                        className="shrink-0 text-text-tertiary"
                      />
                      <span className="truncate text-[12px] text-text-primary">
                        {p.pack.name}
                      </span>
                    </span>
                    <span
                      className={cn(
                        COL.origin,
                        "truncate font-mono text-[10px] text-text-tertiary",
                      )}
                    >
                      {p.source}
                    </span>
                    <span
                      className={cn(
                        COL.tools,
                        "truncate text-[10px] text-text-tertiary",
                      )}
                    >
                      {proj.size > 0
                        ? `${proj.size} tool${proj.size > 1 ? "s" : ""}`
                        : kindCounts(p.pack.components) || "—"}
                    </span>
                    <span
                      className={cn(
                        COL.chevron,
                        "flex justify-end text-text-tertiary",
                      )}
                    >
                      <ChevronRight size={14} />
                    </span>
                  </button>
                );
              })}

              {/* Every installed skill, by its real name. */}
              {skills.map((s) => {
                const onCount = s.cells.filter(
                  (c) => c.scope === scope && c.status === "synced",
                ).length;
                const origin = s.pack
                  ? s.pack
                  : s.managed
                    ? "library"
                    : "external";
                const onClick = () => {
                  // Pack-provided skill → manage its pack (the install unit).
                  const pack = s.pack ? packByName.get(s.pack) : undefined;
                  if (pack) setTarget({ kind: "pack", pack });
                  else setTarget({ kind: "skill", skill: s });
                };
                return (
                  <button
                    key={`skill:${s.pack ?? ""}:${s.name}`}
                    onClick={onClick}
                    className="flex w-full items-center min-h-[44px] py-2 border-b border-border-subtle px-3 text-left transition-colors hover:bg-bg-hover"
                  >
                    <span className={cn(COL.name, "min-w-0 pr-6")}>
                      <span className="block truncate text-[12px] text-text-primary">
                        {s.name}
                      </span>
                      {s.description && (
                        <span className="mt-0.5 text-[10px] leading-snug text-text-tertiary line-clamp-2">
                          {s.description}
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        COL.origin,
                        "truncate text-[11px] text-text-tertiary",
                      )}
                    >
                      {origin}
                    </span>
                    <span
                      className={cn(
                        COL.tools,
                        "text-[11px] text-text-secondary tabular-nums",
                      )}
                    >
                      {onCount > 0 ? `${onCount} on` : "off"}
                    </span>
                    <span
                      className={cn(
                        COL.chevron,
                        "flex justify-end text-text-tertiary",
                      )}
                    >
                      <ChevronRight size={14} />
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Unified manage modal — re-derive the live skill/pack from current state
          on every render so per-tool toggles reflect a mutation immediately (the
          captured `target` object is a stale snapshot from click time). */}
      {target?.kind === "pack" && (
        <PackManageModal
          pack={packByName.get(target.pack.pack.name) ?? target.pack}
          packSkills={(view?.skills ?? []).filter(
            (s) => s.pack === target.pack.pack.name,
          )}
          tools={tools}
          projected={mergeOptimistic(
            packProjected[target.pack.pack.name] ?? new Set<string>(),
            optimistic,
          )}
          detectedFor={detectedFor}
          busy={busy}
          scope={scope}
          effectiveProject={effectiveProject}
          onToggle={(toolId, on) =>
            void togglePackTool(target.pack.pack.name, toolId, on)
          }
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
          skill={
            (view?.skills ?? []).find((s) => s.name === target.skill.name) ??
            target.skill
          }
          tools={tools}
          scope={scope}
          detectedFor={detectedFor}
          busy={busy}
          optimistic={optimistic}
          onToggle={(toolId, status) =>
            void toggleSkillTool(target.skill.name, toolId, status)
          }
          onOpen={() => void openSkill(target.skill.name)}
          onPromote={() => void promoteSkill(target.skill.name)}
          onUninstall={() => void uninstallSkill(target.skill.name)}
          onClose={() => {
            setTarget(null);
            setOptimistic({});
          }}
        />
      )}
    </div>
  );
}

/** A grouped On/Off pill (one rounded container, two segments). */
function OnOff({
  on,
  busy,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-border-default bg-bg-elevated p-0.5">
      {([true, false] as const).map((v) => (
        <button
          key={String(v)}
          type="button"
          disabled={busy}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-[18px] min-w-[34px] items-center justify-center rounded-full px-2 text-[10px] font-medium transition-colors",
            on === v
              ? "bg-bg-selected text-text-primary"
              : "text-text-tertiary hover:text-text-secondary",
          )}
        >
          {v ? "On" : "Off"}
        </button>
      ))}
    </div>
  );
}

/** Per-tool projection toggles for the right pane — Claude Code / Codex etc.
 *  each get a grouped On/Off pill. */
function ToolToggles({
  tools,
  detectedFor,
  statusFor,
  busyFor,
  onClick,
}: {
  tools: ToolInfo[];
  detectedFor: (t: ToolInfo) => boolean;
  statusFor: (t: ToolInfo) => ProjectionStatus;
  busyFor: (t: ToolInfo) => boolean;
  onClick: (t: ToolInfo, status: ProjectionStatus) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
        Deliver to
      </div>
      {tools.map((t) => {
        const status = statusFor(t);
        const detected = detectedFor(t);
        const on = status === "synced";
        const readOnly = status === "pack" || status === "conflict";
        return (
          <div key={t.id} className="flex items-center justify-between">
            <span className="text-[12px] text-text-secondary">
              {t.displayName}
            </span>
            {!detected ? (
              <span
                className="text-[10px] text-text-ghost"
                title="Tool not detected in this scope"
              >
                n/a
              </span>
            ) : readOnly ? (
              <span className="text-[10px] text-text-tertiary capitalize">
                {status}
              </span>
            ) : (
              <OnOff
                on={on}
                busy={busyFor(t)}
                onChange={(next) => {
                  if (next !== on) onClick(t, status);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
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
    void navigator.clipboard.writeText(lines.join("\n"));
  };

  return (
    <SkillModalShell
      open
      onClose={onClose}
      title={pack.pack.name}
      subtitle={`${pack.source} · ${kindCounts(pack.pack.components)}`}
      actions={
        <div className="flex flex-col gap-3">
          <ToolToggles
            tools={tools}
            detectedFor={detectedFor}
            statusFor={(t) => (projected.has(t.id) ? "synced" : "absent")}
            busyFor={(t) => busy === `pack:${pack.pack.name}:${t.id}`}
            onClick={(t) => onToggle(t.id, !projected.has(t.id))}
          />
          <div className="flex flex-col gap-2 border-t border-border-default pt-3">
            <PackUpdate
              scope={scope}
              name={pack.pack.name}
              source={pack.source}
              effectiveProject={effectiveProject}
              projectedTools={projected}
              onDone={onUpdated}
            />
            <ModalAction
              icon={Copy}
              label="Copy as markdown"
              onClick={copyMarkdown}
            />
            <ModalAction
              icon={Github}
              label="View on GitHub"
              onClick={() => void openUrl(githubUrl)}
            />
            <ModalAction
              icon={Trash2}
              label="Uninstall pack"
              variant="danger"
              busy={busy === `delpack:${pack.pack.name}`}
              onClick={onUninstall}
            />
          </div>
        </div>
      }
    >
      <SkillDescriptions
        skills={packSkills.map((s) => ({
          name: s.name,
          description: s.description,
        }))}
        fallback="This pack ships no skills (commands / agents / rules only)."
      />
    </SkillModalShell>
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
    return (
      skill.cells.find((c) => c.tool === t.id && c.scope === scope)?.status ??
      "absent"
    );
  };

  return (
    <SkillModalShell
      open
      onClose={onClose}
      title={skill.name}
      subtitle={`${skill.managed ? "Library skill" : "External skill"} · ${scope}`}
      actions={
        <div className="flex flex-col gap-3">
          <ToolToggles
            tools={tools}
            detectedFor={detectedFor}
            statusFor={statusFor}
            busyFor={(t) => busy === `skill:${skill.name}:${t.id}`}
            onClick={(t, status) => onToggle(t.id, status)}
          />
          <div className="flex flex-col gap-2 border-t border-border-default pt-3">
            <ModalAction
              icon={ExternalLink}
              label="Open in editor"
              onClick={onOpen}
            />
            {scope === "project" && (
              <ModalAction
                icon={ArrowUpCircle}
                label="Promote to global"
                busy={busy === `promote:${skill.name}`}
                onClick={onPromote}
              />
            )}
            <ModalAction
              icon={Trash2}
              label="Uninstall"
              variant="danger"
              busy={busy === `del:${skill.name}`}
              onClick={onUninstall}
            />
          </div>
        </div>
      }
    >
      <SkillDescriptions
        skills={[{ name: skill.name, description: skill.description }]}
      />
    </SkillModalShell>
  );
}

/** Compact Check/Update control for a pack (cheap ls-remote, then re-install). */
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
  const [state, setState] = useState<
    "idle" | "checking" | "available" | "uptodate" | "updating"
  >("idle");

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
      const res = await packsApi.install(
        scope,
        source,
        false,
        effectiveProject,
      );
      if (res.state === "updated") {
        for (const toolId of projectedTools)
          await packsApi.project(
            scope,
            name,
            toolId,
            null,
            true,
            effectiveProject,
          );
      }
      onDone();
      setState("uptodate");
      window.setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("available");
    }
  };

  const base =
    "flex w-full items-center gap-2 rounded-md border border-border-default px-2.5 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary";
  if (state === "checking")
    return (
      <span className={base}>
        <Loader2 size={13} className="animate-spin" /> Checking…
      </span>
    );
  if (state === "updating")
    return (
      <span className={base}>
        <Loader2 size={13} className="animate-spin" /> Updating…
      </span>
    );
  if (state === "uptodate") return <span className={base}>Up to date</span>;
  if (state === "available")
    return (
      <button onClick={apply} className={base}>
        <ArrowUpCircle size={13} /> Update available
      </button>
    );
  return (
    <button onClick={check} className={base}>
      <RefreshCw size={13} /> Check for update
    </button>
  );
}
