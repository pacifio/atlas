// Settings → Skills → Discover. The skills.sh registry: the most installed
// skills, or a live search, one row each with Install. A name opens a dialog
// with the description fetched from the repo.
//
// DATA NOTE: the registry `search` API returns only { id, name, installs,
// source } and 400s on an empty query — no time-series, trending feed, or
// description (the latter needs a repo clone via `pack_remote_preview`). So the
// default view is a cached "Popular" merge of a few seed queries, and detail is
// fetched lazily on open.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Boxes, Check, Copy, Download } from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { copyText } from "@/lib/clipboard";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Icon } from "@/ui/icon";
import { Hint } from "@/ui/tooltip";
import { AtlasLoader } from "@/components/atlas-loader";
import { packs as packsApi } from "@/features/packs/lib/packs-api";
import { skills as skillsApi } from "@/features/skills/lib/skills-api";
import { SKILLS_CHANGED_EVENT } from "@/features/skills/lib/skills-events";
import { SkillDescriptions, SkillDialog } from "./skill-modal";
import {
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "../layout/settings-layout";
import { SettingsSearch } from "../layout/settings-search";
import { TrendSparkline } from "@/components/trend-sparkline";
import { installTrend } from "@/features/packs/lib/install-trends";
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

const PAGE_SIZE = 20;
const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

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
        .catch((e) => toast.error(String(e)))
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

  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => setLimit(PAGE_SIZE), [query]);
  const more = Math.min(PAGE_SIZE, rows.length - limit);

  return (
    <SettingsSection
      title="Discover"
      description="Skills from the skills.sh registry, most installed first."
    >
      <div className="flex">
        <SettingsSearch
          value={query}
          onValueChange={setQuery}
          label="Search the skills registry"
          placeholder="Search the skills registry"
          trailing={loading && <AtlasLoader size={11} />}
        />
      </div>
      <SettingsGroup>
        {rows.length === 0 ? (
          <SettingsNote>
            {loading
              ? "Searching…"
              : query.trim()
                ? `No skill matches “${query.trim()}”.`
                : "Search the registry to find skills."}
          </SettingsNote>
        ) : (
          rows.slice(0, limit).map((hit) => (
            <SettingsRow
              key={hit.id}
              title={
                <button
                  type="button"
                  onClick={() => setSelected(hit)}
                  className="text-left hover:underline"
                >
                  {hit.name}
                </button>
              }
              description={<span className="font-mono">{hit.source}</span>}
              control={
                <>
                  {/* Aesthetic, not analytic: the shape reads as momentum and
                      the number beside it is the exact count. */}
                  <span className="flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
                    <TrendSparkline
                      points={installTrend(hit.id, hit.installs).points}
                      width={48}
                      height={16}
                      label="Installs over the last 6 months"
                    />
                    <Hint label={`${hit.installs.toLocaleString()} installs`}>
                      <span tabIndex={0} className="w-10 text-right">
                        {COMPACT.format(hit.installs)}
                      </span>
                    </Hint>
                  </span>
                  <InstallButton
                    name={hit.name}
                    installed={isHitInstalled(hit)}
                    installing={installingIds.has(hit.id)}
                    onClick={() => install(hit)}
                  />
                </>
              }
            />
          ))
        )}
        {more > 0 && (
          <div className="p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
            >
              Show {more} more
            </Button>
          </div>
        )}
      </SettingsGroup>

      <SkillDetailModal
        hit={selected}
        installed={selected ? isHitInstalled(selected) : false}
        installing={selected ? installingIds.has(selected.id) : false}
        onInstall={() => selected && install(selected)}
        onClose={() => setSelected(null)}
      />
    </SettingsSection>
  );
}

function InstallButton({
  name,
  installed,
  installing,
  onClick,
}: {
  name: string;
  installed: boolean;
  installing: boolean;
  onClick: () => void;
}) {
  if (installed) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-20"
        disabled
        aria-label={`${name} is installed`}
      >
        <Icon icon={Check} size="xs" />
        Installed
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-20"
      disabled={installing}
      aria-label={`Install ${name}`}
      onClick={onClick}
    >
      {installing ? <AtlasLoader size={11} /> : <Icon icon={Download} size="xs" />}
      Install
    </Button>
  );
}

/** Lazily fetches the repo preview (description and components) that the
 *  registry search lacks, and offers Install. */
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

  // Packs rarely carry a manifest description, but the skills inside them do,
  // so the dialog lists those; other kinds (commands, agents, rules) are counts.
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
    void copyText(lines.join("\n"));
  };

  return (
    <SkillDialog
      open={!!hit}
      onClose={onClose}
      title={hit?.name ?? ""}
      subtitle={hit ? `${hit.source} · ${hit.installs.toLocaleString()} installs` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={copyMarkdown}>
            <Icon icon={Copy} size="xs" />
            Copy as Markdown
          </Button>
          <Button variant="ghost" onClick={() => void openUrl(githubUrl)}>
            <GithubIcon size={12} />
            GitHub
          </Button>
          <Button disabled={installed || installing} onClick={onInstall}>
            {installing ? (
              <AtlasLoader size={11} />
            ) : (
              <Icon icon={installed ? Check : Download} size="xs" />
            )}
            {installed ? "Installed" : "Install"}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="caption">Loading details…</p>
      ) : preview ? (
        <>
          {preview.manifest?.description && (
            <p className="text-sm text-secondary-foreground">{preview.manifest.description}</p>
          )}
          {skillComponents.length > 0 && (
            <SkillDescriptions
              skills={skillComponents.map((c) => ({ name: c.name, description: c.description }))}
            />
          )}
          {otherCounts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {otherCounts.map(([kind, n]) => (
                <Badge key={kind} variant="outline">
                  <Icon icon={Boxes} size="xs" />
                  {n} {KIND_LABEL[kind]}
                  {n > 1 ? "s" : ""}
                </Badge>
              ))}
            </div>
          )}
          {!preview.manifest?.description &&
            skillComponents.length === 0 &&
            otherCounts.length === 0 && <p className="caption">No details published.</p>}
        </>
      ) : (
        <p className="caption">Couldn't load the details. You can still install it.</p>
      )}
    </SkillDialog>
  );
}
