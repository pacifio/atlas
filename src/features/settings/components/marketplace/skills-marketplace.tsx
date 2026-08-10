// Settings → Skills → Discover. The skills.sh registry browser, styled as a
// dense monochrome data table (same essence as Settings → API Keys): a sticky
// header, full-width flex rows, fixed columns. Row click opens a centered modal
// with the lazily-fetched description + components and an Install action.
//
// DATA NOTE: the registry `search` API returns only { id, name, installs,
// source } and 400s on an empty query — no time-series, trending feed, or
// description (the latter needs a repo clone via `pack_remote_preview`). So the
// default view is a cached "Popular" merge of a few seed queries, and detail is
// fetched lazily on open.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Boxes, Check, Copy, Download, Github, Loader2, Search, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { packs as packsApi } from "@/features/packs/lib/packs-api";
import { skills as skillsApi } from "@/features/skills/lib/skills-api";
import { SKILLS_CHANGED_EVENT } from "@/features/skills/lib/skills-events";
import { SkillModalShell, SkillDescriptions, ModalAction } from "./skill-modal";
import type { ComponentKind, Pack, PackSearchHit, Scope } from "@/features/packs/lib/types";

const POPULAR_SEEDS = ["agent", "react", "design", "review", "database", "python"];
const POPULAR_LS_KEY = "atlas:skills:popular:v1";

// Cache the first popular fetch so re-entering Discover (or restarting the app)
// shows results instantly instead of re-running the seed searches.
let popularCache: PackSearchHit[] | null = null;

// Cache `pack_remote_preview` results (a repo clone — slow) by source, so
// re-opening a skill's detail modal is instant. Lives for the app session.
const previewCache = new Map<string, Pack>();

// In-flight installs, keyed by registry hit id ("source/skillId"). Lifted to
// MODULE scope (not component state) so the spinner survives unmount — switching
// settings sub-tabs / sections away mid-install no longer loses the loading
// state; returning to Discover shows the install still running, then completes.
const installingIds = new Set<string>();
let installVersion = 0;
const installSubs = new Set<() => void>();
function notifyInstalling() {
  installVersion++;
  installSubs.forEach((f) => f());
}
async function runInstall(hit: PackSearchHit, scope: Scope, projectPath: string | null) {
  if (installingIds.has(hit.id)) return;
  installingIds.add(hit.id);
  notifyInstalling();
  try {
    // Install just THIS skill (not the whole repo) — the registry is skill-level.
    await packsApi.installSkill(scope, hit.source, hit.skillId || hit.name, projectPath);
  } catch (e) {
    toast.error(`Couldn't install ${hit.name}: ${String(e)}`);
  } finally {
    installingIds.delete(hit.id);
    notifyInstalling();
  }
  // `installSkill` fires `atlas:skills-changed`; the component refetches installed.
}

function loadPopularCache(): PackSearchHit[] | null {
  if (popularCache) return popularCache;
  try {
    const raw = localStorage.getItem(POPULAR_LS_KEY);
    if (raw) {
      popularCache = JSON.parse(raw) as PackSearchHit[];
      return popularCache;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function savePopularCache(hits: PackSearchHit[]): void {
  popularCache = hits;
  try {
    localStorage.setItem(POPULAR_LS_KEY, JSON.stringify(hits));
  } catch {
    /* ignore */
  }
}

const KIND_LABEL: Record<ComponentKind, string> = {
  skill: "skill",
  agent: "agent",
  command: "command",
  hook: "hook",
  rule: "rule",
  script: "script",
};

// Shared column widths (header + rows line up). Skill grows; the rest fixed.
const COL = {
  rank: "w-[34px] shrink-0",
  skill: "flex-1 min-w-[220px]",
  source: "w-[200px] shrink-0",
  installs: "w-[110px] shrink-0",
  action: "w-[96px] shrink-0",
} as const;
const TABLE_MIN_W = 34 + 220 + 200 + 110 + 96;

export function SkillsMarketplace({
  scope,
  projectPath,
}: {
  scope: Scope;
  projectPath: string | null;
}) {
  const effectiveProject = scope === "project" ? projectPath : null;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PackSearchHit[]>([]);
  const [popular, setPopular] = useState<PackSearchHit[]>(() => loadPopularCache() ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-render whenever the module-level install registry changes.
  useSyncExternalStore(
    (cb) => {
      installSubs.add(cb);
      return () => installSubs.delete(cb);
    },
    () => installVersion,
  );
  const [selected, setSelected] = useState<PackSearchHit | null>(null);
  // The set of installed skill NAMES (each registry hit is one skill; `skillId`
  // is its name). We check installed-state per skill, NOT per source repo — a
  // repo holds many skills, so "is the repo installed" wrongly marks all of them.
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(new Set());

  const refreshInstalled = useCallback(async () => {
    try {
      const metas = await skillsApi.list(scope, effectiveProject);
      setInstalledSkills(new Set(metas.map((m) => m.name)));
    } catch {
      /* installed badges just won't show */
    }
  }, [scope, effectiveProject]);

  const isHitInstalled = useCallback(
    (hit: PackSearchHit) => installedSkills.has(hit.skillId || hit.name),
    [installedSkills],
  );

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  // Refresh installed badges when a skill/pack mutation lands (incl. an install
  // that completed while this component was unmounted).
  useEffect(() => {
    const onChanged = () => void refreshInstalled();
    window.addEventListener(SKILLS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onChanged);
  }, [refreshInstalled]);

  // Default "Popular" view — only fetched once (then cached). Merge a few broad
  // searches, dedupe by id keeping the highest install count.
  useEffect(() => {
    if (loadPopularCache()) return; // already have it
    let cancelled = false;
    void (async () => {
      const batches = await Promise.allSettled(POPULAR_SEEDS.map((q) => packsApi.search(q)));
      if (cancelled) return;
      const byId = new Map<string, PackSearchHit>();
      for (const b of batches) {
        if (b.status !== "fulfilled") continue;
        for (const hit of b.value) {
          const prev = byId.get(hit.id);
          if (!prev || hit.installs > prev.installs) byId.set(hit.id, hit);
        }
      }
      const merged = [...byId.values()].sort((a, b) => b.installs - a.installs);
      savePopularCache(merged);
      setPopular(merged);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced live search.
  const debRef = useRef<number | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (debRef.current) window.clearTimeout(debRef.current);
    debRef.current = window.setTimeout(() => {
      void packsApi
        .search(q)
        .then((r) => setResults(r.sort((a, b) => b.installs - a.installs)))
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    }, 220);
    return () => {
      if (debRef.current) window.clearTimeout(debRef.current);
    };
  }, [query]);

  const rows = query.trim() ? results : popular;

  const install = useCallback(
    (hit: PackSearchHit) => void runInstall(hit, scope, effectiveProject),
    [scope, effectiveProject],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search — full-width flush bar (mixed into the content), like the
          GitHub panel's search. */}
      <div className="flex h-[32px] shrink-0 items-center gap-1.5 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="shrink-0 text-text-tertiary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the skills registry…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        {loading && <Loader2 size={11} className="animate-spin text-text-tertiary" />}
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="shrink-0 text-text-tertiary hover:text-text-primary cursor-pointer"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-md border border-error/30 bg-error/10 px-3 py-2 text-[11px] text-error">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto hide-scrollbar">
        <div style={{ minWidth: TABLE_MIN_W }}>
          {/* sticky header */}
          <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-border-default bg-bg-base px-3 text-[10px] uppercase tracking-wider text-text-tertiary">
            <span className={cn(COL.rank, "text-right pr-2")}>#</span>
            <span className={COL.skill}>{query.trim() ? "Results" : "Popular"}</span>
            <span className={COL.source}>Source</span>
            <span className={cn(COL.installs, "text-right")}>Installs</span>
            <span className={COL.action} />
          </div>

          {rows.length === 0 ? (
            <div className="grid h-[180px] place-items-center text-[11px] text-text-tertiary">
              {loading
                ? "Searching…"
                : query.trim()
                  ? "No skills match your search."
                  : "Search the registry to discover skills."}
            </div>
          ) : (
            rows.map((hit, i) => {
              const isInstalled = isHitInstalled(hit);
              const installing = installingIds.has(hit.id);
              return (
                <div
                  key={hit.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(hit)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setSelected(hit);
                  }}
                  className="flex w-full cursor-pointer items-center h-[40px] border-b border-border-subtle px-3 text-left transition-colors hover:bg-bg-hover"
                >
                  <span
                    className={cn(
                      COL.rank,
                      "text-right pr-2 font-mono text-[11px] tabular-nums text-text-tertiary",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className={cn(COL.skill, "truncate text-[12px] text-text-primary")}>
                    {hit.name}
                  </span>
                  <span
                    className={cn(COL.source, "truncate font-mono text-[10px] text-text-tertiary")}
                  >
                    {hit.source}
                  </span>
                  <span
                    className={cn(
                      COL.installs,
                      "text-right font-mono text-[11px] tabular-nums text-text-secondary",
                    )}
                  >
                    {hit.installs.toLocaleString()}
                  </span>
                  <span className={cn(COL.action, "flex justify-end")}>
                    <InstallButton
                      installed={isInstalled}
                      installing={installing}
                      onClick={(e) => {
                        e.stopPropagation();
                        install(hit);
                      }}
                    />
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <SkillDetailModal
        hit={selected}
        installed={selected ? isHitInstalled(selected) : false}
        installing={selected ? installingIds.has(selected.id) : false}
        onInstall={() => selected && install(selected)}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

/** Subtle outlined monochrome install control — no accent fill. */
function InstallButton({
  installed,
  installing,
  onClick,
}: {
  installed: boolean;
  installing: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  if (installed) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-text-tertiary">
        <Check size={12} /> Added
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={installing}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-border-default px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
    >
      {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
      Install
    </button>
  );
}

/** Centered modal: lazily fetches the repo preview (description + components)
 *  the registry search lacks, and offers Install. */
function SkillDetailModal({
  hit,
  installed,
  installing,
  onInstall,
  onClose,
}: {
  hit: PackSearchHit | null;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  onClose: () => void;
}) {
  // Seed synchronously from cache so a re-opened modal paints instantly.
  const [preview, setPreview] = useState<Pack | null>(
    hit ? (previewCache.get(hit.source) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!hit) return;
    const cached = previewCache.get(hit.source);
    if (cached) {
      setPreview(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setLoading(true);
    void packsApi
      .remotePreview(hit.source)
      .then((p) => {
        if (cancelled) return;
        previewCache.set(hit.source, p);
        setPreview(p);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [hit]);

  // Packs rarely carry a manifest description, but the skills inside them do —
  // so surface the contained skills + their descriptions (single-skill repos
  // collapse to one entry = "just render their description"). Non-skill kinds
  // (commands/agents/rules) stay as count chips.
  const skillComponents = useMemo(
    () => (preview?.components ?? []).filter((c) => c.kind === "skill"),
    [preview],
  );
  const otherCounts = useMemo(() => {
    const m = new Map<ComponentKind, number>();
    for (const c of preview?.components ?? [])
      if (c.kind !== "skill") m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
    return [...m.entries()];
  }, [preview]);

  const modalSkills = useMemo(
    () => skillComponents.map((c) => ({ name: c.name, description: c.description })),
    [skillComponents],
  );

  const githubUrl = hit ? `https://github.com/${hit.source}` : "";

  const copyMarkdown = () => {
    if (!hit) return;
    const lines = [`# ${hit.name}`, ""];
    if (preview?.manifest?.description) lines.push(preview.manifest.description, "");
    for (const c of skillComponents) {
      lines.push(`## ${c.name}`);
      if (c.description) lines.push("", c.description);
      lines.push("");
    }
    lines.push(`Source: ${githubUrl}`);
    void navigator.clipboard.writeText(lines.join("\n"));
  };

  return (
    <SkillModalShell
      open={!!hit}
      onClose={onClose}
      title={hit?.name ?? ""}
      subtitle={hit ? `${hit.source} · ${hit.installs.toLocaleString()} installs` : undefined}
      actions={
        <div className="flex flex-col gap-2">
          <ModalAction
            icon={installed ? Check : Download}
            label={installed ? "Installed" : "Install"}
            variant="primary"
            busy={installing}
            disabled={installed}
            onClick={onInstall}
          />
          <ModalAction icon={Copy} label="Copy as markdown" onClick={copyMarkdown} />
          {hit && (
            <ModalAction
              icon={Github}
              label="View on GitHub"
              onClick={() => void openUrl(githubUrl)}
            />
          )}
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
          <Loader2 size={13} className="animate-spin" /> Loading details…
        </div>
      ) : preview ? (
        <>
          {preview.manifest?.description && (
            <p className="mb-3 text-[13px] leading-relaxed text-text-secondary">
              {preview.manifest.description}
            </p>
          )}
          {modalSkills.length > 0 && <SkillDescriptions skills={modalSkills} />}
          {otherCounts.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {otherCounts.map(([kind, n]) => (
                <span
                  key={kind}
                  className="inline-flex items-center gap-1 rounded-full border border-border-default bg-bg-base px-2 py-0.5 text-[10px] text-text-tertiary"
                >
                  <Boxes size={10} />
                  {n} {KIND_LABEL[kind]}
                  {n > 1 ? "s" : ""}
                </span>
              ))}
            </div>
          )}
          {!preview.manifest?.description &&
            modalSkills.length === 0 &&
            otherCounts.length === 0 && (
              <div className="text-[12px] text-text-tertiary">No additional details published.</div>
            )}
        </>
      ) : (
        <div className="text-[12px] text-text-tertiary">
          Couldn’t load details — you can still install.
        </div>
      )}
    </SkillModalShell>
  );
}
